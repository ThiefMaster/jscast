"use strict";
var util = require('util'),
    events = require('events'),
    net = require('net'),
    _ = require('underscore'),
    Duration = require('duration'),
    mp3 = require('./mp3'),
    pjson = require('../package.json');

// source client states
var RELAY_NEW = 0, // no socket created
    RELAY_CONNECTING = 1, // connecting
    RELAY_CONNECTED = 2, // connected
    RELAY_GOTSTATUS = 3, // received status line
    RELAY_ACTIVE = 4; // got headers, reading only mp3 data (and metadata)

/*
 * RelaySource emits the following events:
 * - close: When the socket is closed.
 * - streaming: When all headers have been received.
 * - metadata: For each line of metadata received.
 * - audio: Whenever audio data is received. Must be handled or the data is lost.
 */

function RelaySource(host, port, jscast) {
    this.type = 'relay'
    this.host = host;
    this.port = port;
    this.socket = undefined;
    this.jscast = jscast;
    this.state = RELAY_NEW;
    this.userAgent = 'JSCast/' + pjson.version + ' (relaying)';
    this.address = host + ':' + port;
    this.connectTime = undefined;
    this.reconnectTimeout = undefined;
    this.metaInterval = undefined;
    this.bytesAfterMetadata = undefined;
    this.buffer = undefined;
}

util.inherits(RelaySource, events.EventEmitter);

_.extend(RelaySource.prototype, {
    close: function close() {
        console.log('closing relay connection (' + this.address + ')');
        if(this.socket) {
            this.socket.end();
            this.socket.destroy();
            this.socket = undefined;
        }
        this.state = RELAY_NEW;
        this.emit('close');
    },

    reconnect: function reconnect() {
        if(this.socket || this.state !== RELAY_NEW) {
            this.close();
        }
        this.connect();
    },

    scheduleReconnect: function scheduleReconnect(secs) {
        if(this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(this.reconnect.bind(this), secs * 1000);
    },

    getAge: function getAge() {
        return new Duration(this.connectTime).toString(1, 1);
    },

    connect: function _connect() {
        var self = this;
        if(this.socket || this.state !== RELAY_NEW) {
            this.close();
        }
        this.state = RELAY_CONNECTING;
        this.connectTime = new Date();
        this.metaInterval = 0;
        this.bytesAfterMetadata = 0;
        this.buffer = new Buffer(0);
        this.socket = net.connect(this.port, this.host, function() {
            console.log('relay connected');
            self.state = RELAY_CONNECTED;
            var data = [
                'GET / HTTP/1.0',
                'Icy-MetaData: 1',
                'User-Agent: ' + self.userAgent,
                'Host: ' + self.host,
                '',
                ''
            ];
            this.write(data.join('\r\n'));
        });
        console.log('relay connecting (' + this.address + ')');

        this.socket.on('close', function() {
            self.close();
        });
        this.socket.on('data', function(data) {
            self.buffer = Buffer.concat([self.buffer, data]);
            self._handleData();
        });
    },

    _readLine: function _readLine() {
        var pos;
        if(~(pos = this.buffer.indexOf('\n'))) {
            var line = this.buffer.toString('utf-8', 0, pos).trim();
            this.buffer = this.buffer.slice(pos + 1);
            return line;
        }
        return null;
    },

    _handleData: function _handleData() {
        if(this.state === RELAY_CONNECTED) {
            var statusLine = this._readLine();
            if(statusLine === null) {
                return;
            }
            this.state = RELAY_GOTSTATUS;
            console.log('relay received status: ' + statusLine);
            if(statusLine !== 'ICY 200 OK') {
                console.warn('Invalid status line: ' + statusLine);
                this.close();
            }
        }
        else if(this.state === RELAY_GOTSTATUS) {
            var line;
            while((line = this._readLine()) !== null) {
                if(line === '') {
                    this.emit('streaming');
                    this.state = RELAY_ACTIVE;
                    this._handleData();
                    return;
                }
                var parts = line.split(':'),
                    key = parts[0].trim(),
                    value = parts.slice(1).join(':').trim();
                if(key === 'icy-metaint') {
                    this.metaInterval = +value;
                }
                this.emit('metadata', key, value);
            }
        }
        else if(this.state === RELAY_ACTIVE) {
            if(this.buffer.length) {
                this._handleAudio();
            }
        }
    },

    _extractMetadata: function _extractMetadata() {
        var metaPos, metaLength, metaBuf, metadata;

        if(!this.metaInterval || this.bytesAfterMetadata + this.buffer.length < this.metaInterval) {
            // no metadata to deal with
            return true;
        }
        else if(this.bytesAfterMetadata + this.buffer.length === this.metaInterval) {
            // must get more data
            return false;
        }

        metaPos = this.metaInterval - this.bytesAfterMetadata;
        metaLength = 16 * this.buffer.readUInt8(metaPos);
        if(metaPos + 1 + metaLength > this.buffer.length - 1) {
            // meh, need more data again
            return false;
        }
        if(metaLength) {
            metadata = this.buffer.slice(metaPos + 1, metaPos + 1 + metaLength).toString('utf-8');
            this._handleMetadata(metadata.replace(/\0+$/g, ''));
        }
        if(metaPos + 1 + metaLength === this.buffer.length) {
            // No real data after the metadata
            this.buffer = this.buffer.slice(0, metaPos);
        }
        else {
            this.buffer = Buffer.concat([this.buffer.slice(0, metaPos), this.buffer.slice(metaPos + 1 + metaLength)]);
        }
        this.bytesAfterMetadata = -metaPos;
        // recurse in case we have more metadata left
        return this._extractMetadata();
    },

    _handleMetadata: function _handleMetadata(metadata) {
        var match = /^StreamTitle='(.*?)';$/.exec(metadata);
        if(!match) {
            console.warn('Could not parse metadata: ' + metadata);
            return
        }
        var self = this;
        this.jscast.songTitleReceived(match[1]);
    },

    _handleAudio: function _handleAudio() {
        var remainder, usedBytes;
        if(this._extractMetadata() === false) {
            // We have an unfinished metadata block and thus cannot safely extract audio
            return;
        }
        while((remainder = mp3.extractFrame(this.buffer, this._handleFrame.bind(this)))) {
            usedBytes = this.buffer.length - remainder.length;
            this.bytesAfterMetadata += usedBytes;
            this.buffer = remainder;
        }
    },

    _handleFrame: function _handleFrame(header, frame) {
        this.emit('audio', frame);
    }
});


module.exports = {
    RelaySource: RelaySource
};
