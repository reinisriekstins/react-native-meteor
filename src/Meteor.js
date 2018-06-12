/* eslint-disable class-methods-use-this */
import Tracker from 'trackr';
import Minimongo from 'minimongo-cache';
import EJSON from 'ejson';
import DDP from '../lib/ddp.js';
import Random from '../lib/Random.js';
import MeteorError from '../lib/Error.js';
import isReactNative from './isReactNative.js';
import { Collection } from './Collection';
import withTracker from './components/withTracker';
import ReactiveDict from './ReactiveDict';
import Accounts from './user/Accounts';
import { hashPassword } from '../lib/utils';

process.nextTick = setImmediate;

let NetInfo;
let Storage;
let InteractionManager;
let ReactNative;
if (isReactNative) {
  NetInfo = require('react-native').NetInfo; // eslint-disable-line
  Storage = require('react-native').AsyncStorage; // eslint-disable-line
  InteractionManager = require('react-native').InteractionManager; // eslint-disable-line
  ReactNative = require('react-native/Libraries/Renderer/shims/ReactNative'); // eslint-disable-line
} else {
  Storage = localStorage;
}

const Mongo = {
  Collection
};

function runAfterOtherComputations(fn) {
  InteractionManager
    ? InteractionManager.runAfterInteractions(() => {
        Tracker.afterFlush(() => {
          fn();
        });
      })
    : Tracker.afterFlush(() => {
        fn();
      });
}

export default class Meteor {
  constructor(endpoint, options) {
    const defaultOptions = {
      connectionId: Random.id(6)
    }

    this.endpoint = endpoint;
    this.options = { ...defaultOptions, options };
    this._isLoggingIn = false;
    this._db = new Minimongo();
    this._subscriptions = Object.create(null);
    this._collections = Object.create(null);
    this._calls = [];

    this._statusDep = new Tracker.Dependency();
    this._loginDep = new Tracker.Dependency();
    this._userDep = new Tracker.Dependency();
  }

  get connectionId() {
    return this.options.connectionId;
  }

  get users() {
    return this.getCollection('users');
  }

  connect() {
    this._ddp = new DDP({
      endpoint: this.endpoint,
      SocketConstructor: WebSocket,
      ...this.options
    });

    NetInfo.isConnected.addEventListener('connectionChange', isConnected => {
      if (isConnected && this._ddp.autoReconnect) {
        this._ddp.connect();
      }
    });

    this._ddp.on('connected', () => {
      this._statusDep.changed();

      console && console.info('Connected to DDP server.');
      this._loadInitialUser().then(() => {
        this._subscriptionsRestart();
      });
    });

    let lastDisconnect = null;
    this._ddp.on('disconnected', () => {
      this._statusDep.changed();

      console && console.info('Disconnected from DDP server.');
      if (!this._ddp.autoReconnect) {
        return;
      }

      if (!lastDisconnect || new Date() - lastDisconnect > 3000) {
        this._ddp.connect();
      }

      lastDisconnect = new Date();
    });

    this._ddp.on('added', message => {
      if (!this._db[message.collection]) {
        this._db.addCollection(message.collection);
      }

      this._db[message.collection].upsert({
        _id: message.id,
        ...message.fields
      });
    });

    this._ddp.on('ready', message => {
      const idsMap = new Map();
      /*  eslint-disable guard-for-in */
      for (const i in this._subscriptions) {
        const sub = this._subscriptions[i];
        idsMap.set(sub.subIdRemember, sub.id);
      }

      for (const i in message.subs) {
        const subId = idsMap.get(message.subs[i]);
        if (subId) {
          const sub = this._subscriptions[subId];
          sub.ready = true;
          sub.readyDeps.changed();
          sub.readyCallback && sub.readyCallback();
        }
      }
      /* eslint-enable guard-for-in */
    });

    this._ddp.on('changed', message => {
      this._db[message.collection] &&
        this._db[message.collection].upsert({
          _id: message.id,
          ...message.fields
        });
    });

    this._ddp.on('removed', message => {
      this._db[message.collection] &&
        this._db[message.collection].del(message.id);
    });

    this._ddp.on('result', message => {
      const call = this._calls.find(call => call.id === message.id);
      if (typeof call.callback === 'function') {
        call.callback(message.error, message.result);
      }

      this._calls.splice(
        this._calls.findIndex(call => call.id === message.id),
        1
      );
    });

    this._ddp.on('nosub', message => {
      /* eslint-disable guard-for-in */
      for (const i in this._subscriptions) {
        const sub = this._subscriptions[i];
        if (sub.subIdRemember === message.id) {
          console.warn('No subscription existing for', sub.name);
        }
      }
      /* eslint-enable guard-for-in */
    });
  }

  reconnect() {
    this._ddp && this._ddp.connect();
  }

  status() {
    this._statusDep.depend();

    return {
      connected: this._ddp ? this._ddp.status === 'connected' : false,
      status: this._ddp ? this._ddp.status : 'disconnected'
    };
  }

  call(name, ...args) {
    let callback;
    if (args.length && typeof args[args.length - 1] === 'function') {
      callback = args.pop();
    }

    const id = this._ddp.method(name, args);
    this._calls.push({
      id,
      callback
    });
  }

  callAsync(name, ...args) {
    return new Promise((resolve, reject) => {
      this.call(name, ...args, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  }

  subscribe(name, ...params) {
    let callbacks = {};
    if (params.length) {
      const lastParam = params[params.length - 1];
      if (typeof lastParam === 'function') {
        callbacks.onReady = params.pop();
      } else if (
        lastParam &&
        (typeof lastParam.onReady === 'function' ||
          typeof lastParam.onError === 'function' ||
          typeof lastParam.onStop === 'function')
      ) {
        callbacks = params.pop();
      }
    }

    // Is there an existing sub with the same name and param, run in an
    // invalidated Computation? This will happen if we are rerunning an
    // existing computation.
    //
    // For example, consider a rerun of:
    //
    //     Tracker.autorun(function () {
    //       Meteor.subscribe("foo", Session.get("foo"));
    //       Meteor.subscribe("bar", Session.get("bar"));
    //     });
    //
    // If "foo" has changed but "bar" has not, we will match the "bar"
    // subcribe to an existing inactive subscription in order to not
    // unsub and resub the subscription unnecessarily.
    //
    // We only look for one such sub; if there are N apparently-identical subs
    // being invalidated, we will require N matching subscribe calls to keep
    // them all active.

    let existing = false;
    /* eslint-disable guard-for-in */
    for (const i in this._subscriptions) {
      const sub = this._subscriptions[i];
      if (
        sub.inactive &&
        sub.name === name &&
        EJSON.equals(sub.params, params)
      ) {
        existing = sub;
      }
    }
    /* eslint-enable guard-for-in */

    let id;
    if (existing) {
      id = existing.id; // eslint-disable-line
      existing.inactive = false;

      if (callbacks.onReady) {
        // If the sub is not already ready, replace any ready callback with the
        // one provided now. (It's not really clear what users would expect for
        // an onReady callback inside an autorun; the semantics we provide is
        // that at the time the sub first becomes ready, we call the last
        // onReady callback provided, if any.)
        if (!existing.ready) {
          existing.readyCallback = callbacks.onReady;
        }
      }
      if (callbacks.onStop) {
        existing.stopCallback = callbacks.onStop;
      }
    } else {
      // New sub! Generate an id, save it locally, and send message.
      id = Random.id();
      const subIdRemember = this._ddp.sub(name, params);

      this._subscriptions[id] = {
        id,
        subIdRemember,
        name,
        params: EJSON.clone(params),
        inactive: false,
        ready: false,
        readyDeps: new Tracker.Dependency(),
        readyCallback: callbacks.onReady,
        stopCallback: callbacks.onStop,
        stop() {
          this._ddp.unsub(this.subIdRemember);
          delete this._subscriptions[this.id];
          this.ready && this.readyDeps.changed();

          if (callbacks.onStop) {
            callbacks.onStop();
          }
        }
      };
    }

    // return a handle to the application.
    const handle = {
      stop: () => {
        if (this._subscriptions[id]) {
          this._subscriptions[id].stop();
        }
      },
      ready: () => {
        if (!this._subscriptions[id]) {
          return false;
        }

        const record = this._subscriptions[id];
        record.readyDeps.depend();
        return record.ready;
      },
      subscriptionId: id
    };

    if (Tracker.active) {
      // We're in a reactive computation, so we'd like to unsubscribe when the
      // computation is invalidated... but not if the rerun just re-subscribes
      // to the same subscription!  When a rerun happens, we use onInvalidate
      // as a change to mark the subscription "inactive" so that it can
      // be reused from the rerun.  If it isn't reused, it's killed from
      // an afterFlush.
      Tracker.onInvalidate(() => {
        if (this._subscriptions[id]) {
          this._subscriptions[id].inactive = true;
        }

        Tracker.afterFlush(() => {
          if (this._subscriptions[id] && this._subscriptions[id].inactive) {
            handle.stop();
          }
        });
      });
    }

    return handle;
  }

  user() {
    this._userDep.depend();
    if (!this._userIdSaved) return null;

    return this.users.findOne(this._userIdSaved);
  }

  userId() {
    this._userDep.depend();
    if (!this._userIdSaved) return null;

    const user = this.users.findOne(this._userIdSaved);
    return user && user._id;
  }

  loggingIn() {
    this._loginDep.depend();
    return this._isLoggingIn;
  }

  logout(callback) {
    this.call('logout', err => {
      this.handleLogout();
      // TODO: Why reconnect here?
      Meteor.connect();

      typeof callback === 'function' && callback(err);
    });
  }

  handleLogout() {
    Storage.removeItem(`TOKEN/${this.connectionId}`);
    this._tokenIdSaved = null;
    this._userIdSaved = null;
    this._userDep.changed();
  }

  loginWithPassword(selector, password, group, callback) {
    if (typeof selector === 'string') {
      if (selector.indexOf('@') === -1) {
        selector = { username: selector };
      } else {
        selector = { email: selector };
      }
    }

    this._startLoggingIn();
    this.call(
      'login',
      {
        user: selector,
        password: hashPassword(password),
        group
      },
      (err, result) => {
        this._endLoggingIn();

        this._handleLoginCallback(err, result);

        typeof callback === 'function' && callback(err);
      }
    );
  }

  logoutOtherClients(callback = () => {}) {
    this.call('getNewToken', (err, res) => {
      if (err) return callback(err);

      this._handleLoginCallback(err, res);

      this.call('removeOtherTokens', err => {
        callback(err);
      });
    });
  }

  getCollection(name) {
    let collection;
    if (this._collections[name]) {
      collection = this._collections[name];
    } else {
      collection = new Collection(name, { connection: this });
      this._collections[name] = collection;
    }
     
    return collection;
  }

  _login(user, callback) {
    this._startLoggingIn();
    this.call('login', user, (err, result) => {
      this._endLoggingIn();
      this._handleLoginCallback(err, result);
      typeof callback === 'function' && callback(err);
    });
  }

  _startLoggingIn() {
    this._isLoggingIn = true;
    this._loginDep.changed();
  }

  _endLoggingIn() {
    this._isLoggingIn = false;
    this._loginDep.changed();
  }

  _handleLoginCallback(err, result) {
    if (!err) {
      // save user id and token
      Storage.setItem(`TOKEN/${this.connectionId}`, result.token);
      this._tokenIdSaved = result.token;
      this._userIdSaved = result.id;
      this._userDep.changed();
    } else {
      this.handleLogout();
    }
  }

  _loginWithToken(value) {
    this._tokenIdSaved = value;
    if (value !== null) {
      this._startLoggingIn();
      this.call('login', { resume: value }, (err, result) => {
        this._endLoggingIn();
        this._handleLoginCallback(err, result);
      });
    } else {
      this._endLoggingIn();
    }
  }

  getAuthToken() {
    return this._tokenIdSaved;
  }

  async _loadInitialUser() {
    let value = null;
    try {
      value = await Storage.getItem(`TOKEN/${this.connectionId}`);
    } catch (error) {
      console && console.warn(`Error Loading User: ${error.message}`);
    } finally {
      this._loginWithToken(value);
    }
  }

  _subscriptionsRestart() {
    /* eslint-disable guard-for-in */
    for (const i in this._subscriptions) {
      const sub = this._subscriptions[i];
      this._ddp.unsub(sub.subIdRemember);
      sub.subIdRemember = this._ddp.sub(sub.name, sub.params);
    }
    /* eslint-enable guard-for-in */
  }

  _waitDdpReady(cb) {
    if (this._ddp) {
      cb();
    } else {
      runAfterOtherComputations(() => {
        this._waitDdpReady(cb);
      });
    }
  }

  _waitDdpConnected(cb) {
    if (this._ddp && this._ddp.status === 'connected') {
      cb();
    } else if (this._ddp) {
      this._ddp.once('connected', cb);
    } else {
      setTimeout(() => {
        this._waitDdpConnected(cb);
      }, 10);
    }
  }
}

export {
  Accounts,
  Tracker,
  EJSON,
  MeteorError as Error,
  ReactiveDict,
  withTracker,
  isReactNative,
  Mongo
};
