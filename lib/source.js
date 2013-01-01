"use strict";
require('buffertools'); // Buffer.indexOf
var util = require('util'),
    events = require('events'),
    net = require('net'),
    _ = require('underscore');

// source client states
var SOURCE_NEW = 0, // waiting for password
    SOURCE_GOTPASS = 1, // received password
    SOURCE_AUTHENTICATED = 2, // authenticated successfully, waiting for metadata
    SOURCE_ACTIVE = 3; // got metadata, reading only mp3 data

/*
 * SourceClient emits the following events:
 * - close: When the socket is closed.
 * - streaming: When the client finished metadata and thus starts sending audio.
 * - metadata: For each line of metadata received.
 * - authFailed: After authentication failed.
 * - authenticated: After authenticatin succeeded.
 * - audio: Whenever audio data is received. Must be handled or the data is lost.
 */

function SourceClient(socket, authenticator) {
    var self = this;
    this.socket = socket;
    this.authenticator = authenticator;
    this.state = SOURCE_NEW;
    this.ip = socket.remoteAddress;
    this.clientAddress = socket.remoteAddress + ':' + socket.remotePort;
    this.connectTime = Math.floor(Date.now() / 1000);
    this.buffer = new Buffer(0);

    socket.on('close', function() {
        self.emit('close');
    });
    socket.on('data', function(data) {
        self.buffer = Buffer.concat([self.buffer, data])
        self._handleData();
    });
}

util.inherits(SourceClient, events.EventEmitter);

_.extend(SourceClient.prototype, {
    close: function close() {
        console.log('dropping source client (' + this.clientAddress + ')');
        this.socket.end();
        this.socket.destroy();
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
        if(this.state == SOURCE_NEW) {
            var password = this._readLine();
            if(password === null) {
                return;
            }
            this.state = SOURCE_GOTPASS;
            this.authenticator(this.socket.remoteAddress, password, false, this._authChecked.bind(this));
        }
        else if(this.state == SOURCE_AUTHENTICATED) {
            var line;
            while((line = this._readLine()) !== null) {
                if(line === '') {
                    this.emit('streaming');
                    this.state = SOURCE_ACTIVE;
                    this._handleData();
                    return;
                }
                var parts = line.split(':');
                this.emit('metadata', parts[0].trim(), parts.slice(1).join(':').trim());
            }
        }
        else if(this.state == SOURCE_ACTIVE) {
            this._handleAudio();
        }
    },

    _authChecked: function _authChecked(result) {
        if(this.state != SOURCE_GOTPASS) {
            console.error('AuthChecked in state ' + this.state);
        }
        else if(!result) {
            this.emit('authFailed');
            this.close();
        }
        else {
            this.emit('authenticated');
            this.state = SOURCE_AUTHENTICATED;
            this.socket.write('OK2\r\nicy-caps:11\r\n\r\n');
            this._handleData();
        }
    },

    _handleAudio: function _handleAudio() {
        var self = this;
        this.emit('audio', self.buffer)
        this.buffer = new Buffer(0);
    }
});


function createSourceServer(authenticator) {
    var server = net.createServer(function(conn) {
        server.emit('sourceConnected', new SourceClient(conn, authenticator));
    });
    server.maxConnections = 1;
    return server;
}


module.exports = {
    createSourceServer: createSourceServer
};
