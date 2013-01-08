"use strict";

require('./prototypes.js');

var util = require('util'),
    events = require('events'),
    express = require('express'),
    path = require('path'),
    goodwin = require('goodwin'),
    _ = require('underscore'),
    ClientManager = require('./client').ClientManager,
    createSourceServer = require('./source').createSourceServer,
    RelaySource = require('./relay').RelaySource,
    mp3 = require('./mp3'),
    publicWeb = require('./web/public'),
    adminWeb = require('./web/admin');

// Maps request header sent by the source to JSCast.metadata fields
var metaMap = {
    'icy-name': 'stationName',
    'icy-url': 'stationUrl',
    'icy-genre': 'stationGenre',
    'icy-br': 'bitrate'
};


function JSCast(settings) {
    this.settings = settings;
    this._validateSettings();

    // Stream-wide metadata
    this.metadata = {
        song: '',
        bitrate: 0,
        stationName: settings.stream.metaOverride.stationName || 'N/A',
        stationUrl: settings.stream.metaOverride.stationUrl || 'http://www.example.com',
        stationGenre: settings.stream.metaOverride.stationGenre || 'Various'
    };

    this.activeSource = null;
    this.audioBuffer = new Buffer(this.settings.stream.bufferSize);
    this.audioBufferUsed = 0;

    this._initClientManager();
    if(this.settings.relay.enabled) {
        this._initRelay();
    }
    else {
        this._initSourceServer();
    }
    this._initHttpServer();
    this._bindHttpRoutes();
}

util.inherits(JSCast, events.EventEmitter);

_.extend(JSCast.prototype, {
    listen: function listen() {
        this.httpServer.listen(this.settings.network.port, this.settings.network.ip);
        this._startSource();
    },

    authenticate: function authenticate(ip, password, admin, callback) {
        // This method must be overwritten to implement authentication
        console.error('Default authenticate() method rejects everything.');
        callback(false);
    },

    updateSongTitle: function updateSongTitle(title, callback) {
        // This method can be overwritten to intercept song title updates and e.g. delay them.
        callback(title);
    },

    songTitleReceived: function songTitleReceived(title) {
        var self = this;
        this.updateSongTitle(title, function(song) {
            self.metadata.song = song;
            self.emit('songChanged', song);
        });
    },

    addPlaybackClient: function addPlaybackClient(req, res) {
        this.clientManager.newClient(req, res);
    },

    kickSource: function kickSource() {
        if(this.activeSource) {
            this.activeSource.close();
            console.log('Kicked source');
        }
    },

    _validateSettings: function _validateSettings() {
        var self = this;
        var requiredSettings = [
            'passwords.dj:string',
            'passwords.admin:string',
            'network.ip:string',
            'network.port:number',
            'relay.enabled',
            'relay.enabled::relay.host',
            'relay.enabled::relay.port:number',
            'stream.metaInterval:number',
            'stream.bufferSize:number'
        ];
        var failed = false;
        _.each(requiredSettings, function(item) {
            var onlyIf, onlyIfBool, key, type, parts;
            if(~item.indexOf('::')) {
                parts = item.split('::');
                onlyIf = parts[0];
                item = parts[1];
                onlyIfBool = false;
                if(onlyIf.substr(0, 1) === '!') {
                    onlyIfBool = true;
                    onlyIf = onlyIf.substr(1);
                }
            }
            if(~item.indexOf(':')) {
                parts = item.split(':');
                key = parts[0];
                type = parts[1];
            }
            else {
                key = item;
            }
            if(onlyIf && goodwin.getPathValue(onlyIf, self.settings) == onlyIfBool) {
                // Don't validate if prerequisite is not met
                return;
            }
            var value = goodwin.getPathValue(key, self.settings);
            if(value === undefined) {
                console.error('Required config option ' + key + ' is missing');
                failed = true;
            }
            else if(type !== undefined && typeof value !== type) {
                console.error('Required config option ' + key + ' must be a ' + type);
                failed = true;
            }
        });

        if(failed) {
            throw new Error('Configuration check failed.');
        }

        // Create optional parent fields so they are never undefined
        if(!this.settings.stream.metaOverride) {
            this.settings.stream.metaOverride = {};
        }
    },

    _initClientManager: function _initClientManager() {
        var self = this;
        this.clientManager = new ClientManager(this);
        this.clientManager.on('clientConnected', function(client) {
            console.log('Client connected: ' + client.id);
            client.write(self.audioBuffer.slice(0, self.audioBufferUsed));
        });
        this.clientManager.on('clientDisconnected', function(client) {
            console.log('Client disconnected: ' + client.id);
        });
    },

    _initRelay: function _initRelay() {
        var self = this;
        this.relaySource = new RelaySource(this.settings.relay.host, this.settings.relay.port, this);
        this._addSourceHandlers(this.relaySource);
        this.relaySource.on('close', function() {
            this.scheduleReconnect(2);
        });
        this._startSource = this.relaySource.connect.bind(this.relaySource);
    },

    _initSourceServer: function _initSourceServer() {
        var self = this;
        this.sourceServer = createSourceServer(this);
        this.sourceServer.on('sourceConnected', function(source) {
            console.log('Source connected: ' + source.address);
            self._addSourceHandlers(source);
        });
        this._startSource = function _startSource() {
            this.sourceServer.listen(this.settings.network.port + 1, this.settings.network.ip);
        };
    },

    _addSourceHandlers: function _addSourceHandlers(source) {
        var self = this;

        source.on('close', function() {
            console.log('Source closed: ' + this.address);
            if(this === self.activeSource) {
                console.log('Active source client lost!');
                self.activeSource = null;
                self.metadata.bitrate = 0;
            }
        });

        source.on('streaming', function() {
            console.log('Source started streaming: ' + this.address);
            self.activeSource = this;
        });

        source.on('metadata', function(key, value) {
            console.log('Source sent metadata: ' + key + ' = ' + value);
            if(metaMap[key] && !self.settings.stream.metaOverride[metaMap[key]]) {
                self.metadata[metaMap[key]] = value;
            }
        });

        source.on('audio', function(frame) {
            while(self.audioBufferUsed + frame.length > self.audioBuffer.length) {
                // Remove frames until we have space
                var header = mp3.parseHeader(new Uint8Array(self.audioBuffer));
                self.audioBuffer.copy(self.audioBuffer, 0, header.frameBytes, self.audioBufferUsed);
                self.audioBufferUsed -= header.frameBytes;
            }
            frame.copy(self.audioBuffer, self.audioBufferUsed);
            self.audioBufferUsed += frame.length;
            self.emit('audio', frame);
        });
    },

    _initHttpServer: function _initHttpServer() {
        var app = this.httpServer = express();
        app.configure(function() {
            app.set('views', __dirname + '/../templates');
            app.set('view engine', 'jade');
            app.use(express.logger('dev'));
            app.use(express.favicon());
            app.use(express.bodyParser());
            app.use(app.router);
            app.use(express.static(path.join(__dirname, '../public')));
        });

        app.configure('development', function(){
            app.use(express.errorHandler());
            app.locals.pretty = true;
        });
    },

    _bindHttpRoutes: function _bindHttpRoutes() {
        var self = this,
            app = this.httpServer; // for convenience

        var httpAuth = express.basicAuth(function(user, password, next) {
            if(user !== 'admin') {
                next(false, false);
            }
            else {
                self.authenticate(null, password, true, function(valid) {
                    next(false, valid);
                });
            }
        });

        // index page. starts the stream if UA is apparently not a browser
        app.get('/', function(req, res) {
            if(!~req.headers['user-agent'].indexOf('Mozilla')) {
                self.addPlaybackClient(req, res);
            }
            else {
                publicWeb.index.call(self, req, res);
            }
        });

        // optional entry point that always starts the stream
        app.get('/;', function(req, res) {
            self.addPlaybackClient(req, res);
        });

        // shoutcast-compatible admin interface
        app.get('/admin.cgi', adminWeb.shoutcast.bind(this)); // authentication via GET param checked internally
        app.get('/admin/', httpAuth, adminWeb.index.bind(this));
        app.get('/admin/kick-listener/:id', httpAuth, adminWeb.kickListener.bind(this));
        app.get('/admin/kick-source', httpAuth, adminWeb.kickSource.bind(this));
    }
});

module.exports = {
    JSCast: JSCast
};
