"use strict";
var util = require('util'),
    events = require('events'),
    uuid = require('node-uuid'),
    _ = require('underscore'),
    Duration = require('duration');


function PlaybackClient(manager, req, res, id) {
    var self = this;
    this.manager = manager;
    this.req = req;
    this.res = res;
    this.id = id;
    this.connectTime = new Date();
    this.userAgent = req.headers['user-agent'];
    this.bytesSent = 0;
    this.wantsMetadata = (req.headers['icy-metadata'] === '1');
    this.lastMetadata = undefined;

    req.on('close', function() {
        self.emit('close');
    });
    req.socket.setTimeout(0);

    var headers = {
        'icy-name': manager.metadata.stationName,
        'icy-url': manager.metadata.stationUrl,
        'icy-genre': manager.metadata.stationGenre,
        'content-type': 'audio/mpeg'
    };
    if(this.wantsMetadata) {
        headers['icy-metaint'] = this.manager.metaInterval;
    }
    res.useChunkedEncodingByDefault = false;
    res.sendDate = false;
    res._storeHeader('ICY 200 OK\r\n', headers);
}

util.inherits(PlaybackClient, events.EventEmitter);

_.extend(PlaybackClient.prototype, {
    close: function close() {
        this.res.end();
        this.emit('close');
    },

    write: function write(data) {
        var beforeMeta = this.manager.metaInterval - (this.bytesSent % this.manager.metaInterval);

        if(!this.wantsMetadata || data.length < beforeMeta) {
            this.res.write(data);
            this.bytesSent += data.length;
            return;
        }

        this.res.write(data.slice(0, beforeMeta));
        this.bytesSent += beforeMeta;
        this._sendMetadata();
        if(data.length > beforeMeta) {
            // By doing this recursively we avoid problems in the unlikely case that we'd still have more
            // than metaInterval bytes left.
            this.write(data.slice(beforeMeta));
        }
    },

    getAge: function getAge() {
        return new Duration(this.connectTime).toString(1);
    },

    _sendMetadata: function _sendMetadata() {
        // Nothing is escaped. Not even single quotes. FUGLY! But that's how Shoutcast does it, too.
        var metadata = "StreamTitle='" + this.manager.metadata.song + "';";
        if(metadata === this.lastMetadata) {
            this.res.write(new Buffer([0]));
            return;
        }
        var size = Math.ceil(metadata.length / 16);
        var buf = new Buffer(1 + size * 16);
        buf.fill(0);
        buf.writeUInt8(size, 0);
        buf.write(metadata, 1);
        this.res.write(buf);
        this.lastMetadata = metadata;
    }
});


function ClientManager(metaInterval, metadata) {
    this.clients = {};
    this.metaInterval = metaInterval;
    this.metadata = metadata;
}

util.inherits(ClientManager, events.EventEmitter);

_.extend(ClientManager.prototype, {
    newClient: function newClient(req, res) {
        var self = this;
        var id;
        do {
            id = uuid.v4();
        } while(this.clients[id]);

        var client = this.clients[id] = new PlaybackClient(this, req, res, id);
        client.on('close', function() {
            delete self.clients[client.id];
            self.emit('clientDisconnected', client);
        });
        this.emit('clientConnected', client);
        return client;
    },

    getClient: function getClient(id) {
        return this.clients[id];
    },

    kickClient: function kickClient(id) {
        var client = this.clients[id];
        if(client) {
            client.close();
        }
    },

    broadcast: function broadcast(data) {
        _.each(this.clients, function(client) {
            client.write(data);
        });
    }
});

module.exports = {
    ClientManager: ClientManager
};
