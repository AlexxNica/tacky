var Hoek = require('hoek');
var Insync = require('insync');

var defaults = {
    expiresIn: 3600000,
    privacy: 'default'
};
var pkg = require('../package.json');
var NAME = pkg.name;

var internals = {};

exports.register = function (server, options, next) {

    internals.settings = Hoek.applyToDefaults(defaults, options);
    internals.cache = server.cache({
        expiresIn: internals.settings.expiresIn,
        cache: internals.settings.cache
    });

    server.ext('onPreResponse', internals.extensionPoint);
    server.handler('cache', internals.handler.bind(options.bind));
    next();
};

exports.register.attributes = {
    pkg: pkg
};

internals.handler = function (route, options) {

    Hoek.assert(typeof options.hydrate === 'function', 'hydrate must be a function.');
    Hoek.assert(route.method === 'get', 'only "get" methods are supported.');

    // This is to prevent confusion about what cach headers to use when sending the response
    // any cache related settings should be under `options` and not under route.settings.cache
    delete route.settings.cache;

    var settings = Hoek.applyToDefaults({
        generateKey: function (request) {

            return request.raw.req.url;
        }
    }, options);

    var self = this;
    return function (request, reply) {

        var cacheKey = settings.generateKey.call(self, request);
        var privacy = options.privacy || internals.settings.privacy;

        // Waterfall functions
        var hydrate = settings.hydrate.bind(self, request);
        var done = function (err, data) {

            if (err) {
                return reply(err);
            }

            var response = reply(data.result);
            response.plugins[NAME] = {
                cache: data.cache,
                state: data.state
            };
        };
        var afterHydrate = function (cacheSettings) {

            return function (result /*, [state], [next]*/) {

                var next;
                var state;
                if (arguments.length === 3) {
                    state = arguments[1];
                    next = arguments[2];
                }
                else {
                    state = null;
                    next = arguments[1];
                }

                next(null, {
                    result: result,
                    state: state,
                    cache: cacheSettings
                });
            };
        };
        var checkCache = function (next) {

            internals.cache.get(cacheKey, function (err, value, cached) {

                if (err) {
                    request.log(['cache', 'error'], {
                        message: 'Error looking up ' + cacheKey + ' in the cache',
                        error: err
                    });
                }

                // If the value is in the cache, short-circuit the waterfall and
                // call out to the end. This is the documented way to short-circuit
                // a Insync waterfall.
                if (cached) {
                    return done(null, {
                        result: value,
                        cache: {
                            ttl: cached.ttl,
                            privacy: privacy
                        },
                        state: null
                    });
                }
                next(null);
            });
        };

        var tasks = [];
        /* eslint-disable*/
        if (cacheKey == null) {
        /* eslint-enable*/
            tasks.push(hydrate, afterHydrate(null));
        }
        else {
            tasks.push(checkCache, hydrate);
            tasks.push(afterHydrate({ ttl: internals.settings.expiresIn, privacy: privacy }));
            tasks.push(function (data, next) {

                var tail = request.tail('cache tail');
                internals.cache.set(cacheKey, data.result, null, function (cacheErr) {

                    if (cacheErr) {
                        request.log(['cache', 'error'], {
                            message: 'Error setting cache for ' + cacheKey,
                            error: cacheErr
                        });
                    }
                    tail();
                });
                next(null, data);
            });
        }

        Insync.waterfall(tasks, done);
    };
};

internals.getCacheString = function (ttl, privacy) {

    var age = Math.floor(ttl / 1000);
    var header = 'max-age=' + age + ', must-revalidate';

    if (privacy !== 'default') {
        header += ', ' + privacy;
    }
    return header;
};

internals.extensionPoint = function (request, reply) {

    var response = request.response;

    if (response.isBoom) {
        return reply.continue();
    }

    var cache = Hoek.reach(response, 'plugins.' + NAME + '.cache');

    if (cache) {
        // Random number between 60% of the ttl and the TTL.
        var ttl = internals.between(cache.ttl * .60, cache.ttl);

        response.header('cache-control', internals.getCacheString(ttl, cache.privacy));
    }
    reply.continue();
};

internals.between = function (min, max) {

    min = Math.floor(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1) + min);
};
