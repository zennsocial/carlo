/**
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const EventEmitter = require('events');

class Server {
  constructor() {
    this.lastObjectId_ = 0;
    this.factories_ = new Map();
    this.services_ = new Map();
    this.objects_ = new Map();
  }

  /**
   * @param {!Page} page
   * @return {!Promise}
   */
  async init(page) {
    this.page_ = page;
    await Promise.all([
      this.page_.exposeFunction('rpcSend', this.onMessage_.bind(this)),
      this.page_.evaluateOnNewDocument(installClient)
    ]);
  }

  /**
   * @param {function(new:EventEmitter)} c Constructor of the remotely accessible
   *     service object.
   */
  exposeFactory(c) {
    this.factories_.set(c.prototype.constructor.name, c);
  }

  /**
   * @param {string} name Service name.
   * @param {!Object} object Service object.
   */
  exposeObject(name, object) {
    this.services_.set(name, object);
  }

  async onMessage_(message) {
    if (message.create || message.lookup) {
      let objectId;
      let object;
      if (message.create) {
        const c = this.factories_.get(message.create);
        object = new c();
        objectId = `create#${message.create}#${++this.lastObjectId_}#`;
      } else {
        object = this.services_.get(message.lookup);
        objectId = `lookup#${message.lookup}#${++this.lastObjectId_}#`;
      }
      this.objects_.set(objectId, object);
      object.emit = (method, ...args) => { this.sendMessage_({objectId, method, args})};
      this.sendMessage_({
        id: message.id,
        result: { methods: this.describe_(object), objectId }
      });
      return;
    }

    if (message.dispose) {
      this.objects_.delete(message.objectId);
      return;
    }

    const object = this.objects_.get(message.objectId);
    const result = await object[message.method](...message.args);
    this.sendMessage_({id: message.id, objectId: message.objectId, result});
  }

  sendMessage_(message) {
    this.page_.evaluate(message => self.rpc.dispatchMessage(message), message);
  }

  /**
   * @param {!Object} o
   */
  describe_(o) {
    const proto = o.__proto__;
    const methods = [];
    for (const name in Object.getOwnPropertyDescriptors(proto)) {
      if (name === 'constructor')
        continue;
      if (typeof proto[name] === 'function')
        methods.push(name);
    }
    return methods;
  }
}

function installClient() {
  class EventEmitter {
    constructor(objectId) {
      this.objectId_ = objectId;
      this.listeners_ = new Map();
    }

    on(event, handler) {
      let listeners = this.listeners_.get(event);
      if (!listeners) {
        listeners = [];
        this.listeners_.set(event, listeners);
      }
      listeners.push(handler);
    }

    off(event, handler) {
      let listeners = this.listeners_.get(event);
      if (!listeners)
        return;
      listeners = listeners.filter(a => a !== handler);
    }

    emit_(event, ...args) {
      let listeners = this.listeners_.get(event);
      if (!listeners)
        return;
      for (const listener of listeners)
        listener(...args);
    }
  }

  class Client {
    constructor() {
      this.lastId_ = 0;
      this.callbacks_ = new Map();
      this.objects_ = new Map();
    }

    async create(service) {
      const result = await this.sendMessage_({create: service});
      return this.wrap_(result.objectId, result.methods);
    }

    async lookup(name) {
      const result = await this.sendMessage_({lookup: name});
      return this.wrap_(result.objectId, result.methods);
    }

    wrap_(objectId, methods) {
      const object = new EventEmitter(objectId);
      this.objects_.set(objectId, object);
      for (const method of methods)
        object[method] = (...args) => this.sendMessage_({method, objectId, args});
      object.dispose = async () => {
        this.sendMessage_({dispose: 'dispose', objectId });
        this.objects_.delete(objectId);
      };
      return object;
    }

    sendMessage_(message) {
      message.id = ++this.lastId_;
      let callback;
      const result = new Promise(fulfil => this.callbacks_.set(message.id, fulfil));
      rpcSend(message);
      return result;
    }

    onMessage_(message) {
      if (typeof message.id === 'number') {
        this.callbacks_.get(message.id)(message.result);
        return;
      }
      this.objects_.get(message.objectId).emit_(message.method, ...message.args);
    }
  }

  const client = new Client();
  self.rpc = {
    create: service => client.create(service),
    lookup: service => client.lookup(service),
    dispatchMessage: message => client.onMessage_(message),
  };
}

module.exports = { Server };
