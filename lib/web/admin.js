"use strict";

var _ = require('underscore');

// Note: All exported functions are called with `this` being the JSCast instance

// Shoutcast-style API
exports.shoutcast = function shoutcast(req, res) {
    var self = this,
        command = req.query.mode || 'index',
        password = req.query.pass,
        requireAdmin = (command !== 'updinfo');

    this.authenticate(req.ip, password, requireAdmin, function(valid) {
        if(!valid) {
            res.send(403, 'Authentication failed.');
            res.end();
            return;
        }

        if(!shoutcastCommands[command]) {
            res.send(404, 'Not Found.');
            res.end();
        }
        else {
            shoutcastCommands[command].call(self, req, res);
        }
    });
};

var shoutcastCommands = {
    index: function index(req, res) { // TODO: move away. does not need to be shoutcast-compatible
        res.write('Clients:\n');
        _.each(this.clientManager.clients, function(client) {
            res.write('* ' + client.id + ' [' + client.req.ip + '] - ' + client.bytesSent + ' bytes\n');
        });
        res.write('\nSource: ' + (this.activeSource ? this.activeSource.ip : 'None'));
        res.end();
    },

    updinfo: function updinfo(req, res) {
        var self = this;
        var song = req.query.song;
        var queryString, match;
        if(/%[A-F0-9]{2}/.test(song) && ~((queryString = require('url').parse(req.url).query).indexOf(song))) {
            // We got something that was not UTF8 and thus need to extract and decode it (assuming iso-8859-1)
            // Of course this is super ugly but the only safe way avoid problems in the unlikely case that a valid
            // song title actually contains %XX (and thus already decoded successfully).
            if((match = /(?:[?&]|^)song=([^&#]*)/.exec(queryString))) {
                song = match[1].replace(/%([A-F0-9]{2})/gi, function(f, m1) {
                    return String.fromCharCode(parseInt(m1, 16));
                });
            }
        }
        this.updateSongTitle(song, function(song) {
            self.metadata.song = song;
            self.emit('songChanged', song);
        });
        res.end();
    },

    kicksrc: function kicksrc(req, res) {
        if(this.activeSource) {
            this.activeSource.close();
        }
        console.log('Kicked source');
        res.end();
    },

    kickdst: function kickdst(req, res) { // TODO: move away. does not need to be shoutcast-compatible
        this.clientManager.kickClient(req.query.dst);
        console.log('Kicked listener');
        res.end();
    }
};
