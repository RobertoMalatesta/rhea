/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 */
'use strict';

var url = require('url');

var simple_id_generator = {
    counter : 1,
    next : function() {
        return this.counter++;
    }
};

var Client = function (container, address) {
    var u = url.parse(address);
    //TODO: handle scheme and user/password if present
    this.connection = container.connect({'host':u.hostname, 'port':u.port});
    this.connection.on('message', this._response.bind(this));
    this.connection.on('receiver_open', this._ready.bind(this));
    this.sender = this.connection.attach_sender(u.path);
    this.receiver = this.connection.attach_receiver({source:{dynamic:true}});
    this.id_generator = simple_id_generator;
    this.pending = [];//requests yet to be made (waiting for receiver to open)
    this.outstanding = {};//requests sent, for which responses have not yet been received
};

Client.prototype._request = function (id, name, args, callback) {
    var request = {properties:{}};
    request.properties.subject = name;
    request.body = args;
    request.properties.message_id = id;
    request.properties.reply_to = this.receiver.remote.attach.source.address;
    this.outstanding[id] = callback;
    this.sender.send(request);
};

Client.prototype._response = function (context) {
    var id = context.message.properties.correlation_id;
    var callback = this.outstanding[id];
    if (callback) {
        callback(context.message.body);
    } else {
        console.log('no request pending for ' + id + ', ignoring response');
    }
};

Client.prototype._ready = function (context) {
    this._process_pending();
};

Client.prototype._process_pending = function () {
    for (var i = 0; i < this.pending.length; i++) {
        var r = this.pending[i];
        this._request(r.id, r.name, r.args, r.callback);
    }
    this.pending = [];
};

Client.prototype.call = function (name, args, callback) {
    var id = this.id_generator.next();
    if (this.receiver.is_open() && this.pending.length === 0) {
        this._request(id, name, args, callback);
    } else {
        //need to wait for reply-to address
        this.pending.push({'name':name, 'args':args, 'callback':callback, 'id':id});
    }
};

Client.prototype.close = function () {
    this.receiver.close();
    this.sender.close();
    this.connection.close();
};

Client.prototype.define = function (name) {
    this[name] = function (args, callback) { this.call(name, args, callback); };
};

var Cache = function (ttl, purged) {
    this.ttl = ttl;
    this.purged = purged;
    this.entries = {};
    setTimeout(this.purge.bind(this), this.ttl);
};

Cache.prototype.put = function (key, value) {
    this.entries[key] = {'value':value, 'last_accessed': Date.now()};
    setTimeout();
};

Cache.prototype.get = function (key) {
    var entry = this.entries[key];
    if (entry) {
        entry.last_accessed = Date.now();
        return entry.value;
    } else {
        return undefined;
    }
};

Cache.prototype.purge = function() {
    //TODO: this could be optimised if the map is large
    var now = Date.now();
    var expired = [];
    for (var k in this.entries) {
        if (now - this.entries[k].last_accessed >= this.ttl) {
            expired.push(k);
        }
    }
    for (var i = 0; i < expired.length; i++) {
        var entry = this.entries[expired[i]];
        delete this.entries[expired[i]];
        this.purged(entry);
    }
};

var LinkCache = function (factory, ttl) {
    this.factory = factory;
    this.cache = new Cache(ttl, function(link) { link.close(); });
}

LinkCache.prototype.get = function (address) {
    var link = this.cache.get(address);
    if (link === undefined) {
        link = this.factory(address);
        this.cache.put(address, link);
    }
    return link;
};

var Server = function (container, address) {
    var u = url.parse(address);
    //TODO: handle scheme and user/password if present
    this.connection = container.connect({'host':u.hostname, 'port':u.port});
    this.connection.on('connection_open', this._connection_open.bind(this));
    this.connection.on('message', this._request.bind(this));
    this.receiver = this.connection.attach_receiver(u.path);
    this.callbacks = {};
    this.pending = [];//responses waiting to be sent
    this._send = function (msg) { this.pending.push(msg); };
};

function match(desired, offered) {
    if (offered) {
        if (Array.isArray(offered)) {
            return offered.indexOf(desired) > -1;
        } else {
            return desired === offered;
        }
    } else {
        return false;
    }
}

Server.prototype._connection_open = function (context) {
    if (match('ANONYMOUS-RELAY', this.connection.remote.open.offered_capabilities)) {
        var relay = this.connection.attach_sender();
        this._send = function (msg) { relay.send(msg); };
    } else {
        var cache = new LinkCache(this.connection.attach_sender.bind(this.connection), 60000);
        this._send = function (msg) { var s = cache.get(msg.properties.to); if (s) s.send(msg); };
    }
    for (var i = 0; i < this.pending.length; i++) {
        this._send(this.pending[i]);
    }
    this.pending = [];
}

Server.prototype._respond = function (response) {
    var server = this;
    return function (result, error) {
        if (error) {
            response.properties.subject = error.name || 'error';
            response.body = error;
        } else {
            response.properties.subject = 'ok';
            response.body = result;
        }
        server._send(response);
    };
}

Server.prototype._request = function (context) {
    var request = context.message;
    var response = {properties:{}};
    response.properties.to = request.properties.reply_to;
    response.properties.correlation_id = request.properties.message_id;
    var callback = this.callbacks[request.properties.subject];
    if (callback) {
        callback(request.body, this._respond(response));
    } else {
        response.properties.subject = 'bad-method';
        response.body = 'Unrecognised method ' + request.properties.subject;
        this._send(response);
    }
};

Server.prototype.bind_sync = function (f, name) {
    this.callbacks[name || f.name] = function (args, callback) { var result = f(args); callback(result); };
};
Server.prototype.bind = function (f, name) {
    this.callbacks[name || f.name] = f;
};

Server.prototype.close = function () {
    this.receiver.close();
    this.connection.close();
};

module.exports = {
    server : function(container, address) { return new Server(container, address); },
    client : function(connection, address) { return new Client(connection, address); }
};