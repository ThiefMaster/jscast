"use strict";
var yaml = require('js-yaml'),
    fs = require('fs'),
    _ = require('underscore'),
    JSCast = require('./').JSCast;

function loadSettings(configFile) {
    if(!fs.existsSync(configFile)) {
        console.error('Config file ' + configFile + ' does not exist.');
        process.exit(1);
    }

    try {
        return yaml.safeLoad(fs.readFileSync(configFile, 'utf8'));
    }
    catch(e) {
        console.error('Could not load config file: ' + e);
        process.exit(1);
    }
}

function simpleAuthenticator(ip, password, admin, callback) {
    if(password === settings.passwords.admin) {
        callback(admin || !settings.passwords.strictAdmin);
    }
    else {
        callback(!admin && password === settings.passwords.dj);
    }
}

var settings = loadSettings(process.argv.length > 2 ? process.argv[2] : 'jscast.yml');
settings.authenticator = simpleAuthenticator;

var jscast = new JSCast(settings);
jscast.listen();
