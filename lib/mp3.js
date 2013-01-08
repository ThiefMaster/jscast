"use strict";

var BitString = require('bitstring');

var sampleRates = [
    [11025, 12000, 8000], // MPEG 2.5
    [0, 0, 0], // reserved
    [22050, 24000, 16000], // MPEG 2
    [44100, 48000, 32000] // MPEG 1
];

var sampleCounts = [
    [0, 576, 1152, 384], // MPEG 2.5
    [0, 0, 0, 0], // reserved
    [0, 576, 1152, 384], // MPEG 2
    [0, 1152, 1152, 384] // MPEG 1
];

var bitRates = [
    [ // MPEG 2.5
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // reserved
        [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0], // Layer 3
        [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0], // Layer 2
        [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256,0] // Layer 1
    ],
    [ // reserved
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // reserved
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // reserved
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // reserved
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] // reserved
    ],
    [ // MPEG 2
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // reserved
        [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0], // Layer 3
        [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0], // Layer 2
        [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256,0] // Layer 1
    ],
    [ // MPEG 1
        [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // reserved
        [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0], // Layer 3
        [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384,0], // Layer 2
        [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448,0] // Layer 1
    ]
];

function parseHeader(buf) {
    var bs = new BitString('', buf);
    bs.seek(0); // because this stupid library puts the pointer at the END of the data
    bs.readbits(11); // skip sync word
    var header = {};
    header.id = bs.readbits(2);
    header.layer = bs.readbits(2);
    header.protection = bs.readbits(1);
    header.bitRate = bitRates[header.id][header.layer][bs.readbits(4)] * 1000;
    header.sampleRate = sampleRates[header.id][bs.readbits(2)];
    header.padding = bs.readbits(1);
    bs.readbits(1); // unused "private" field
    header.channels = bs.readbits(2);
    header.modex = bs.readbits(2);
    header.copyright = bs.readbits(1);
    header.original = bs.readbits(1);
    header.emphasis = bs.readbits(2);
    header.sampleCount = sampleCounts[header.id][header.layer];
    if(header.layer === 3) { // that's layer 1
        // just for completeness... we'll only get MPEG-1 Layer 3 here anyway when coming from extractFrame
        header.frameBytes = (Math.floor(12 * header.bitRate / header.sampleRate) + header.padding) * 4;
    }
    else {
        header.frameBytes = Math.floor(144 * header.bitRate / header.sampleRate) + header.padding;
    }
    return header;
}

function extractFrame(buf, callback) {
    var arr = new Uint8Array(buf);
    var index = arr.indexOfMulti([0xff, 0xfb]);
    if(index === -1 || index + 4 > arr.length - 1) {
        // Nothing found or incomplete header => return original buffer
        return null;
    }
    var header = parseHeader(arr.slice(index));
    if(index + header.frameBytes > arr.length - 1) {
        return null;
    }
    callback(header, buf.slice(index, index + header.frameBytes));
    return buf.slice(index + header.frameBytes);
}

module.exports = {
    parseHeader: parseHeader,
    extractFrame: extractFrame
};
