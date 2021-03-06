// Copyright 2015 The Vanadium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

require('es6-shim');

var promisify = require('es6-promisify');
var syncbase = require('syncbase');
var vanadium = require('vanadium');
var verror = vanadium.verror;

var $ = require('../util/jquery');
var defineClass = require('../util/define-class');

var debug = require('../debug');

/**
 * Create app, db, and table structure in Syncbase.
 */
function setUp(context, app, db) {
  function nonfatals(err) {
    if (err instanceof verror.ExistError) {
      console.info(err.msg);
    } else {
      throw err;
    }
  }

  //TODO(rosswang) If {} will remain empty, can it be omitted?
  return promisify(app.create.bind(app))(context, {})
    .catch(nonfatals)
    .then(function() {
      return promisify(db.create.bind(db))(context, {});
    })
    .catch(nonfatals)
    .then(function() {
      var table = db.table('t');
      return promisify(table.create.bind(table))(context, {});
    })
    .catch(nonfatals);
}

function joinKey(key) {
  return key.join('.');
}

function splitKey(key) {
  return key.split('.');
}

/**
 * Translate Syncbase hierarchical keys to object structure for easier
 * processing. '.' is chosen as the separator; '/' is reserved in Syncbase.
 *
 * It might be ideal to have the separator configurable, but certain separators
 * need regex escaping.
 */
function recursiveSet(root, key, value) {
  var member = key[0];

  if (key.length > 1) {
    var child = root[member];
    if (!child) {
      child = root[member] = {};
    } else if (typeof child !== 'object') {
      child = root[member] = { _: child };
    }

    recursiveSet(child, key.slice(1), value);
  } else {
    var obj = root[member];
    if (obj) {
      obj._ = value;
    } else {
      root[member] = value;
    }
  }
}

function recursiveDelete(root, key) {
  var member = key[0];

  if (key.length > 1) {
    var child = root[member];
    if (typeof child === 'object') {
      recursiveDelete(child, key.slice(1));
      if ($.isEmptyObject(child)) {
        delete root[member];
      }
    }
  } else {
    delete root[member];
  }
}

var SG_MEMBER_INFO = new syncbase.nosql.SyncgroupMemberInfo();

// TODO(rosswang): generalize this
// If this is updated, the regex in escapeKeyElement needs updating too.
var ESC = {
  '_': '_',
  '.': 'd',
  '@': 'a',
  '/': 's',
  ':': 'c'
};

var INV = {};
$.each(ESC, function(k, v) {
  INV[v] = k;
});

var SyncbaseWrapper = defineClass({
  statics: {
    start: function(context, mountName) {
      var service = syncbase.newService(mountName);
      var app = service.app('travel');
      var db = app.noSqlDatabase('db');

      return setUp(context, app, db).then(function() {
        return new SyncbaseWrapper(context, db, mountName);
      });
    },

    escapeKeyElement: function(str) {
      return str.replace(/_|\.|@|\/|:/g, function(m) {
        return '_' + ESC[m];
      });
    },

    unescapeKeyElement: function(str) {
      return str.replace(/_(.)/g, function(m, p1) {
        return INV[p1];
      });
    }
  },

  publics: {
    /**
     * @param fn a function executing the batch operations, receiving as its
     *  `this` context and first parameter the batch operation methods
     *  (put, delete), each of which returns a promise. The callback must return
     *  the overarching promise.
     */
    batch: function(fn){
      var self = this;
      var opts = new syncbase.nosql.BatchOptions();

      return this.manageWrite(this.runInBatch(this.context, this.db, opts,
        function(db, cb) {
          var t = db.table('t');
          var putToSyncbase = promisify(t.put.bind(t));
          var deleteFromSyncbase = promisify(t.deleteRange.bind(t));

          var ops = {
            put: function(k, v) {
              return self.standardPut(putToSyncbase, k, v);
            },
            delete: function(k) {
              return self.standardDelete(deleteFromSyncbase, k);
            }
          };

          var p = fn.call(ops, ops);
          if (p) {
            p.then(function(result) {
              return cb(null, result);
            }, function(err) {
              return cb(err);
            });
          } else {
            cb();
          }
        }));
    },

    /**
     * @param k array of key elements
     * @param v serialized value
     */
    put: function(k, v) {
      return this.manageWrite(this.standardPut(this.putToSyncbase, k, v));
    },

    delete: function(k) {
      return this.manageWrite(this.standardDelete(this.deleteFromSyncbase, k));
    },

    // TODO(rosswang): transitional

    getData: function() {
      return this.data;
    },

    /**
     * Since I/O is asynchronous, sparse, and fast, let's avoid concurrency/
     * merging with the local syncbase instance by only starting a refresh if
     * no writes are in progress and the refresh finishes before any new writes
     * have started. Client watch should help make this better. In any case if
     * this becomes starved, we can be smarter by being sensitive to keys being
     * updated at any given time.
     *
     * We can also get around this problem by restructuring the data flow to
     * be unidirectional with the local Syncbase as the authority, though that
     * introduces (hopefully negligible) latency and complicates forked response
     * on user input for the same data.
     *
     * @returns a void promise for this refresh
     */
    refresh: function() {
      var self = this;

      var current = this.pull.current;
      if (!current) {
        current = this.pull.current = this.pull().then(function(data) {
            self.pull.current = null;
            self.data = data;
            self.onUpdate(data);
            return data;
          }, function(err) {
            self.pull.current = null;
            throw err;
          });
      }

      return current;
    },

    /**
     * @see refresh
     */
    pull: function(prefix) {
      var self = this;

      function repull() {
        return self.pull(prefix);
      }

      if (this.writes.size) {
        return Promise.all(this.writes)
          .then(repull, repull);

      } else {
        this.dirty = false;

        return new Promise(function(resolve, reject) {
          var newData = {};
          var abort = false;

          var isHeader = true;

          var query = 'select k, v from t';
          if (prefix) {
            query += ' where k like "' + joinKey(prefix) + '%"';
          }

          self.db.exec(self.context, query, function(err) {
            if (err) {
              reject(err);
            } else if (abort) {
              //no-op; promise has already been resolved.
            } else if (self.dirty) {
              debug.log('Syncbase: aborting refresh due to writes');
              resolve(repull()); //try/wait for idle again
            } else {
              resolve(newData);
            }
          }).on('data', function(row) {
            if (isHeader) {
              isHeader = false;
              return;
            }

            if (abort) {
              //no-op
            } else if (self.dirty) {
              abort = true;
              resolve(repull()); //try/wait for idle again
              /* It would be nice to abort this stream for real, but we can't.
               * Leave this handler attached but no-oping to drain the stream.
               */
            } else {
              recursiveSet(newData, splitKey(row[0]), row[1]);
            }
          }).on('error', reject);
        }).catch(function(err) {
          if (err instanceof verror.InternalError) {
            console.error(err);
          } else {
            throw err;
          }
        });
      }
    },

    // TODO(rosswang): end transitional

    syncgroup: function(sgAdmin, name) {
      var self = this;

      name = vanadium.naming.join(sgAdmin, '%%sync', name);
      var sg = this.db.syncgroup(name);

      //syncgroup-promisified
      var sgp;

      function chainable(cb) {
        return function(err) {
          cb(err, sgp);
        };
      }

      var create = promisify(function(spec, cb) {
        debug.log('Syncbase: create syncgroup ' + name);
        sg.create(self.context, spec, SG_MEMBER_INFO, chainable(cb));
      });

      var destroy = promisify(function(cb) {
        debug.log('Syncbase: destroy syncgroup ' + name);
        sg.destroy(self.context, cb);
      });

      var join = promisify(function(cb) {
        sg.join(self.context, SG_MEMBER_INFO, chainable(cb));
      });

      var getSpec = promisify(function(cb) {
        sg.getSpec(self.context, function(err, spec, version) {
          cb(err, {
            spec: spec,
            version: version
          });
        });
      });

      var setSpec = promisify(function(spec, version, cb) {
        sg.setSpec(self.context, spec, version, chainable(cb));
      });

      /* Be explicit about arg lists because promisify is sensitive to extra
       * args. i.e. even though destroy and join could just be fn refs, since
       * they're made by promisify, wrap them in a fn that actually takes 0
       * args. */
      sgp = {
        buildSpec: function(prefixes, mountTables, admin, initialPermissions) {
          return new syncbase.nosql.SyncgroupSpec({
            perms: new Map([
              ['Admin', {in: [admin]}],
              ['Read', {in: initialPermissions}],
              ['Write', {in: initialPermissions}],
              ['Resolve', {in: initialPermissions}],
              ['Debug', {in: [admin]}]
            ]),
            prefixes: prefixes.map(function(p) {
              return new syncbase.nosql.TableRow({
                tableName: 't',
                row: joinKey(p)
              });
            }),
            mountTables: mountTables
          });
        },

        create: function(spec) { return create(spec); },
        destroy: function() { return destroy(); },
        join: function() { return join(); },
        getSpec: function() { return getSpec(); },
        setSpec: function(spec, version) { return setSpec(spec, version); },
        changeSpec: function(fn) {
          return sgp.getSpec().then(function(versionedSpec) {
            var spec = versionedSpec.spec;
            return sgp.setSpec(fn(spec) || spec, versionedSpec.version)
              .catch(function(err) {
                if (err instanceof verror.VersionError) {
                  return sgp.changeSpec(fn);
                } else {
                  throw err;
                }
              });
          });
        },

        createOrJoin: function(spec) {
          return sgp.create(spec)
            .catch(function(err) {
              if (err instanceof verror.ExistError) {
                debug.log('Syncbase: syncgroup ' + name + ' already exists.');
                return sgp.join();
              } else {
                throw err;
              }
            });
        },

        joinOrCreate: function(spec) {
          return sgp.join()
            .catch(function(err) {
              if (err instanceof verror.NoExistError) {
                debug.log('Syncbase: syncgroup ' + name + ' does not exist.');
                return sgp.createOrJoin(spec);
              } else {
                throw err;
              }
            });
        }
      };

      return sgp;
    },

    /**
     * @return {
     *    data,
     *    onChange*(key, ?value, continued),
     *    onUpdate*(data),
     *    onError*(err),
     *    onClose*(?err)
     *  }
     */
    getWatchedObject: function(prefix) {
      var result = {
        data: {}
      };

      var onChange = defineClass.event(result, 'onChange');
      var onUpdate = defineClass.event(result, 'onUpdate');
      var onError = defineClass.event(result, 'onError');
      var onClose = defineClass.event(result, 'onClose', 'memory');

      function put(k, v) {
        recursiveSet(result.data, k, v);
      }

      return this.getRawWatched(prefix, {
        onData: put
      }, {
        onPut: function(k, v, continued) {
          put(k, v);
          onChange(k, v, continued);
        },
        onDelete: function(k, continued) {
          recursiveDelete(result.data, k);
          onChange(k, null, continued);
        },
        onBatchEnd: function() {
          onUpdate(result.data);
        },
        onError: onError,
        onClose: onClose
      }).then(function() {
        return result;
      });
    },

    /**
     * Pulls data from Syncbase and registers watch handlers. Returns a promise
     * resolving after the initial pull.
     *
     * @param pullHandler { onData(key, value), onError(err) }
     * @param streamHandler {
     *    ?onPut(key, value, continued),
     *    ?onDelete(key, continued),
     *    ?onBatchEnd(),
     *    onError(err),
     *    onClose(?err)
     *  }; These are callbacks rather than events to guarantee that no updates
     *  are missed. `continued` indicates whether a change is followed by more
     *  changes in same batch.
     * @return a promise resolving after the initial pull completes. Watch
     *  callbacks may continue to be called until onClose.
     */
    getRawWatched: function(prefix, pullHandler, streamHandler) {
      var self = this;

      var resumeMarker;

      var opts = new syncbase.nosql.BatchOptions();
      return self.runInBatch(self.context, self.db, opts, function(db, cb) {
          Promise.all([
            self.pull2(db, prefix, pullHandler.onData, pullHandler.onError),
            promisify(db.getResumeMarker.bind(db))(self.context)
          ]).then(function(args) {
            resumeMarker = args[1];
            cb('abort');
          }, cb);
        }).catch(function(err) {
          if (err !== 'abort') {
            throw err;
          }

          var stream = self.db.watch(self.context, 't', joinKey(prefix),
            resumeMarker, streamHandler.onClose);
          stream.on('data', function(change) {
            try {
              switch(change.changeType) {
              case 'put':
                new Promise(function(resolve, reject) {
                  if (streamHandler.onPut) {
                    change.getValue(function(err, value) {
                      if (err) {
                        reject(err);
                      } else {
                        resolve(streamHandler.onPut(splitKey(change.rowName),
                          value, change.continued));
                      }
                    });
                  } else {
                    resolve();
                  }
                }).then(function() {
                  if (!change.continued && streamHandler.onBatchEnd) {
                    return streamHandler.onBatchEnd();
                  }
                }).catch(streamHandler.onError);
                break;
              case 'delete':
                new Promise(function(resolve, reject) {
                  if (streamHandler.onDelete) {
                    resolve(streamHandler.onDelete(splitKey(change.rowName),
                      change.continued));
                  } else {
                    resolve();
                  }
                }).then(function() {
                  if (!change.continued && streamHandler.onBatchEnd) {
                    return streamHandler.onBatchEnd();
                  }
                }).catch(streamHandler.onError);
                break;
              default:
                streamHandler.onError(
                  new Error('Invalid change type ' + change.changeType));
              }
            } catch(err) {
              streamHandler.onError(err);
            }
          }).on('error', streamHandler.onError);
        });
    },
  },

  privates: {
    /**
     * TODO(rosswang): transitional: pull2 => pull
     *
     * Handlers may continue to be called even after the promise has been
     * rejected.
     *
     * @param onData handler callback that takes a key, value pair.
     * @param onError handler callback that takes an error.
     * @return a promise that resolves when the pull is complete or rejects if
     *  the pull failed or either handler threw.
     */
    pull2: function(db, prefix, onData, onError) {
      var self = this;

      return new Promise(function(resolve, reject) {
        var isHeader = true;

        var query = 'select k, v from t';
        if (prefix) {
          query += ' where k like "' + joinKey(prefix) + '%"';
        }

        db.exec(self.context, query, function(err) {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }).on('data', function(row) {
          if (isHeader) {
            isHeader = false;
            return;
          }

          try {
            onData(splitKey(row[0]), row[1]);
          } catch (err) {
            reject(err);
          }
        }).on('error', function(err) {
          if (!onError) {
            reject(err);
          } else {
            try {
              onError(err);
            } catch (err2) {
              reject(err2);
            }
          }
        });
      });
    },

    /* TODO(rosswang): Keep this around even though the dirty flag and write
     * records are not used since watch integration, because there is still a
     * potential race condition; I'm just not particularly sure how to deal with
     * it yet. If it turns out we don't have to worry about it, delete this. */
    manageWrite: function(promise) {
      var writes = this.writes;

      this.dirty = true;
      writes.add(promise);

      return promise.then(function(v) {
        writes.delete(promise);
        return v;
      }, function(err) {
        writes.delete(promise);
        throw err;
      });
    },

    standardPut: function(fn, k, v) {
      k = joinKey(k);
      return fn(this.context, k, v);
    },

    standardDelete: function(fn, k) {
      k = joinKey(k);
      debug.log('Syncbase: delete ' + k);
      return fn(this.context, syncbase.nosql.rowrange.prefix(k));
    }
  },

  constants: [ 'mountName' ],

  // TODO(rosswang): transitional
  events: {
    onError: 'memory',
    onUpdate: '',
  },
  // TODO(rosswang): end transitional

  init: function(context, db, mountName) {
    // TODO(rosswang): mountName probably won't be necessary after syncgroup
    // admin instances are hosted (see group-manager).
    var self = this;
    this.context = context;
    this.db = db;
    this.t = db.table('t');
    this.mountName = mountName;

    this.writes = new Set();

    this.runInBatch = promisify(syncbase.nosql.runInBatch);
    this.putToSyncbase = promisify(this.t.put.bind(this.t));
    this.deleteFromSyncbase = promisify(this.t.deleteRange.bind(this.t));

    // TODO(rosswang): transitional
    function watchLoop() {
      if (!self.pull.current) {
        self.refresh().catch(self.onError);
      }
      setTimeout(watchLoop, 500);
    }
    process.nextTick(watchLoop);
    // TODO(rosswang): end transitional
  }
});

module.exports = SyncbaseWrapper;
