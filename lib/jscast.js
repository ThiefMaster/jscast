"use strict";
var util = require('util'),
    events = require('events'),
    express = require('express'),
    goodwin = require('goodwin'),
    _ = require('underscore'),
    ClientManager = require('./client').ClientManager,
    createSourceServer = require('./source').createSourceServer;

// Maps request header sent by the source to JSCast.metadata fields
var metaMap = {
    'icy-name': 'stationName',
    'icy-url': 'stationUrl',
    'icy-genre': 'stationGenre'
};


function JSCast(settings) {
    this.settings = settings;
    this._validateSettings();

    // Stream-wide metadata
    this.metadata = {
        song: 'N/A',
        stationName: settings.stream.metaOverride.stationName || 'N/A',
        stationUrl: settings.stream.metaOverride.stationUrl || 'http://www.example.com',
        stationGenre: settings.stream.metaOverride.stationGenre || 'Various'
    };

    this.activeSource = null;
    this._initClientManager();
    this._initSourceServer();
    this._initHttpServer();
    this._bindHttpRoutes();
}

util.inherits(JSCast, events.EventEmitter);

_.extend(JSCast.prototype, {
    listen: function listen() {
        this.httpServer.listen(this.settings.network.port, this.settings.network.ip);
        this.sourceServer.listen(this.settings.network.port + 1, this.settings.network.ip);
    },

    _validateSettings: function _validateSettings() {
        var self = this;
        var requiredSettings = [
            'passwords.dj:string',
            'passwords.admin:string',
            'network.ip:string',
            'network.port:number',
            'stream.metaInterval:number'
        ];
        var failed = false;
        _.each(requiredSettings, function(item) {
            var key, type;
            if(~item.indexOf(':')) {
                var parts = item.split(':');
                key = parts[0];
                type = parts[1];
            }
            else {
                key = item;
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
        this.clientManager = new ClientManager(this.settings.stream.metaInterval, this.metadata);
        this.clientManager.on('clientConnected', function(client) {
            console.log('Client connected: ' + client.id);
        });
        this.clientManager.on('clientDisconnected', function(client) {
            console.log('Client disconnected: ' + client.id);
        });
    },

    _initSourceServer: function _initSourceServer() {
        var self = this;
        this.sourceServer = createSourceServer(this.settings.authenticator);
        this.sourceServer.on('sourceConnected', function(source) {
            console.log('Source connected: ' + source.clientAddress);
            source.on('close', function() {
                console.log('Source closed: ' + this.clientAddress);
                if(this === self.activeSource) {
                    console.log('Active source client lost!');
                    self.activeSource = null;
                }
            });
            source.on('streaming', function() {
                console.log('Source started streaming: ' + this.clientAddress);
                self.activeSource = this;
            });
            source.on('metadata', function(key, value) {
                console.log('Source sent metadata: ' + key + ' = ' + value);
                if(metaMap[key] && !self.settings.stream.metaOverride[metaMap[key]]) {
                    self.metadata[metaMap[key]] = value;
                }
            });
            source.on('audio', function(data) {
                self.clientManager.broadcast(data);
            });
        });
    },

    _initHttpServer: function _initHttpServer() {
        var app = this.httpServer = express();
        app.configure(function() {
            app.use(express.logger('dev'));
            app.use(express.bodyParser());
            app.use(app.router);
        });

        app.configure('development', function(){
            app.use(express.errorHandler());
        });
    },

    _bindHttpRoutes: function _bindHttpRoutes() {
        var self = this,
            app = this.httpServer; // for convenience

        // index page. starts the stream if UA is apparently not a browser
        app.get('/', function(req, res) {
            if(!~req.headers['user-agent'].indexOf('Mozilla')) {
                self.clientManager.newClient(req, res);
                return;
            }

            res.end('Welcome to NodeCast!');
        });

        // optional entry point that always starts the stream
        app.get('/;', function(req, res) {
            self.clientManager.newClient(req, res);
        });

        // admin interface. must be called like this so shoutcast sources do not break
        // TODO: move away everything that's not API-ish
        app.get('/admin.cgi', function(req, res) {
            var command = req.query.mode;
            var password = req.query.pass;
            var requireAdmin = (command !== 'updinfo');

            self.settings.authenticator(req.ip, password, requireAdmin, function(valid) {
                if(!valid) {
                    res.send(403, 'Authentication failed.');
                    res.end();
                    return;
                }

                self._handleAdminCommand(req, res, command);
            });
        });
    },

    _handleAdminCommand: function _handleAdminCommand(req, res, command) {
        if(!command) {
            res.write('Clients:\n');
            _.each(this.clientManager.clients, function(client) {
                res.write('* ' + client.id + ' [' + client.req.ip + '] - ' + client.bytesSent + ' bytes\n');
            });
            res.write('\nSource: ' + (this.activeSource ? this.activeSource.ip : 'None'));
        }
        else if(command === 'updinfo') {
            this.metadata.song = req.query.song;
            this.emit('songChanged', this.metadata.song);
        }
        else if(command === 'kicksrc') {
            if(this.activeSource) {
                this.activeSource.close();
            }
            console.log('Kicked source');
        }
        else if(command === 'kickdst') {
            this.clientManager.kickClient(req.query.dst);
            console.log('Kicked listener');
        }
        else {
            res.send(404, 'Not Found.');
        }

        res.end();
    }
});

module.exports = {
    JSCast: JSCast
};
