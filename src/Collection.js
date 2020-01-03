/* eslint-disable import/prefer-default-export */
import Tracker from 'trackr';
import EJSON from 'ejson';
import Random from '../lib/Random';
import { isPlainObject } from '../lib/utils.js';

export class Cursor {
  constructor(collection, docs) {
    this._docs = docs || [];
    this._collection = collection;
  }

  count() {
    return this._docs.length;
  }

  fetch() {
    return this._transformedDocs();
  }

  forEach(callback) {
    this._transformedDocs().forEach(callback);
  }

  map(callback) {
    return this._transformedDocs().map(callback);
  }

  _transformedDocs() {
    return this._collection._transform
      ? this._docs.map(this._collection._transform)
      : this._docs;
  }
}

export class Collection {
  constructor(name, options = {}) {
    this.connection = options.connection;

    if (!this.connection._db[name]) {
      this.connection._db.addCollection(name);
    }

    this._collection = this.connection._db[name];
    this._cursoredFind = options.cursoredFind;
    this._name = name;
    this._transform = wrapTransform(options.transform);
    this._dep = new Tracker.Dependency();
    
    this.connection._db.on('change', this._handleDataChange);
  }

  find(selector, options) {
    this._dep.depend();

    let result;
    let docs;

    if (typeof selector === 'string') {
      if (options) {
        docs = this._collection.findOne({ _id: selector }, options);
      } else {
        docs = this._collection.get(selector);
      }

      if (docs) docs = [docs];
    } else {
      docs = this._collection.find(selector, options);
    }

    if (this._cursoredFind) {
      result = new Cursor(this, docs);
    } else {
      if (docs && this._transform) docs = docs.map(this._transform);

      result = docs;
    }

    return result;
  }

  findOne(selector, options) {
    this._dep.depend();

    let result = this.find(selector, options);

    if (result) {
      if (this._cursoredFind) result = result.fetch();

      result = result[0];
    }

    return result;
  }

  insert(item, callback = () => {}) {
    let id;

    if ('_id' in item) {
      if (!item._id || typeof item._id != 'string') {
        return callback(
          'Meteor requires document _id fields to be non-empty strings'
        );
      }
      id = item._id;
    } else {
      id = item._id = Random.id();
    }

    if (this._collection.get(id))
      return callback({
        error: 409,
        reason: `Duplicate key _id with value ${id}`
      });

    this._collection.upsert(item);
    this.connection._waitDdpConnected(() => {
      this.connection.call(`/${this._name}/insert`, item, err => {
        if (err) {
          this._collection.del(id);
          return callback(err);
        }

        callback(null, id);
      });
    });

    return id;
  }

  update(id, modifier, options = {}, callback = () => {}) {
    if (typeof options == 'function') {
      callback = options;
      options = {};
    }

    if (!this._collection.get(id))
      return callback({
        error: 409,
        reason: `Item not found in collection ${this._name} with id ${id}`
      });

    // change mini mongo for optimize UI changes
    this._collection.upsert({ _id: id, ...modifier.$set });

    this.connection._waitDdpConnected(() => {
      this.connection.call(
        `/${this._name}/update`,
        { _id: id },
        modifier,
        err => {
          if (err) {
            return callback(err);
          }

          callback(null, id);
        }
      );
    });
  }

  remove(id, callback = () => {}) {
    const element = this.findOne(id);

    if (element) {
      this._collection.del(element._id);

      this.connection._waitDdpConnected(() => {
        this.connection.call(
          `/${this._name}/remove`,
          { _id: id },
          (err, res) => {
            if (err) {
              this._collection.upsert(element);
              return callback(err);
            }
            callback(null, res);
          }
        );
      });
    } else {
      callback(`No document with _id : ${id}`);
    }
  }

  _handleDataChange = (changeRecord) => {
    if (changeRecord[this._name]) {
      this._dep.changed();
    }
  }
}

// Wrap a transform function to return objects that have the _id field
// of the untransformed document. This ensures that subsystems such as
// the observe-sequence package that call `observe` can keep track of
// the documents identities.
//
// - Require that it returns objects
// - If the return value has an _id field, verify that it matches the
//   original _id field
// - If the return value doesn't have an _id field, add it back.
function wrapTransform(transform) {
  if (!transform) return null;

  // No need to doubly-wrap transforms.
  if (transform.__wrappedTransform__) return transform;

  var wrapped = function(doc) {
    if (doc._id) {
      // XXX do we ever have a transform on the oplog's collection? because that
      // collection has no _id.
      throw new Error('can only transform documents with _id');
    }

    var id = doc._id;
    // XXX consider making tracker a weak dependency and checking Package.tracker here
    var transformed = Tracker.nonreactive(function() {
      return transform(doc);
    });

    if (!isPlainObject(transformed)) {
      throw new Error('transform must return object');
    }

    if (transformed._id) {
      if (!EJSON.equals(transformed._id, id)) {
        throw new Error("transformed document can't have different _id");
      }
    } else {
      transformed._id = id;
    }
    return transformed;
  };
  wrapped.__wrappedTransform__ = true;
  return wrapped;
}
