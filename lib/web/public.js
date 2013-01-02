"use strict";

// Note: All exported functions are called with `this` being the JSCast instance

exports.index = function index(req, res) {
    res.render('index.jade', {metadata: this.metadata});
}
