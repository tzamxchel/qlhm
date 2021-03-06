// Dependencies
var util = require("util")

  , moment = require("moment")
  , restify = require("restify")

  , logTime = require("./lib/logging").logTime
  , Scriptish_parser = require("./lib/scriptish").Scriptish_parser
  , uso = require("./lib/uso")
  , SCRIPT_CACHE = require("./lib/scriptcache")
  ;


// The latest "hook.js" version
var LATEST_CLIENT_VERSION = 0.3
  , LATEST_CLIENT_DOWNLOAD_URL = "https://github.com/supahgreg/qlhm/wiki/Version-History"
  ;


// Create the server
var server = restify.createServer();


// Middleware
server.use(restify.acceptParser(server.acceptable));
server.use(restify.queryParser());
server.use(restify.jsonp());
server.use(restify.gzipResponse());

server.use(function(req, res, next) {
  logTime("%s %s %s", req.headers["x-forwarded-for"] || req.connection.remoteAddress, req.method, req.url);
  next();
});


// Routes
server.get({path: "/versioncheck", version: "1.0.0"}, function(req, res, next) {
  var clientVer = parseFloat(req.params.currentVersion);
  if (!isNaN(clientVer) && clientVer >= LATEST_CLIENT_VERSION) return res.send({});
  res.send({"new": {version: LATEST_CLIENT_VERSION, url: LATEST_CLIENT_DOWNLOAD_URL}});
});

server.get({path: "/serving", version: "1.0.0"}, function(req, res, next) {
  var scripts = SCRIPT_CACHE.map(function(aID, aScript) {
    return {
        id: aID
      , name: (aScript.isValid() ? (aScript.headers.name+"") : "not available")
    }
  });

  scripts.sort(function(a, b) {
    a = a.name.toLowerCase(), b = b.name.toLowerCase();
    return (a < b ? -1 : a > b ? 1 : 0);
  });

  res.send(scripts);
});

server.get({path: /^\/uso\/?(.*)?/i, version: "1.0.0"}, function(req, res, next) {
  var scriptID = uso.parseID(req.params[0]);
  if (!scriptID) return res.send(404, {error: "Invalid or missing options.  '/uso/[id_number]' and '/uso/[full_url_to_.user.js]' are accepted."});

  // Get the cached script, or create an new entry if needed
  var script = SCRIPT_CACHE.get(scriptID, true);

  // Send from cache if available and we're not due for a refresh attempt
  if (!script.updateCheckNeeded()) {
    if (script.isValid()) {
      // Only update the decreasing number of minutes
      script.meta.nextCheckMinutes = script.nextCheck.diff(moment(), "minutes");
      return res.send(script);
    }
    else {
      var tryAgainIn = moment.isMoment(script.nextCheck) ? util.format("  You can try again %s.", script.nextCheck.fromNow()) : ""
        , errMsg = util.format("Previous request for script with ID %d failed.%s", scriptID, tryAgainIn)
        ;
      logTime(errMsg);
      return res.send(403, { error: errMsg });
    }
  }
  // Otherwise try a request from USO
  else {
    logTime("Performing a new metadata request for script %d", scriptID);

    uso.getMeta(scriptID, function(aError, aHeaders) {
      if (404 === aError) {
        logTime("404 received for script metadata %d", scriptID);
        // Wait 60 minutes if USO said the metadata couldn't be found
        script.updateMetaTimes(60);
        return res.send(404, {error: util.format("Metadata for script with ID %d was not found", scriptID)});
      }
      else if (aError) {
        logTime("Non-404 error for script metadata %d: %s", scriptID, aError);
        // Wait 5 minutes if there was a non-404 error in retrieval
        script.updateMetaTimes(5);

        // Send the previous content if available
        if (script.isValid()) return res.send(script);
        return res.send(404, {error: "Invalid metadata request"});
      }

      // Successful metadata retrieval... check if script is cached, and if metadata version is different
      var scriptName = aHeaders.name ? aHeaders.name[0] : "unspecified";
      logTime("Successful metadata retrieval for script %d (\"%s\")", scriptID, scriptName);

      // If we have a cached response with the same "uso:version" update times and send the script along
      if (!script.isOlderThan(aHeaders["uso:version"][0])) {
        logTime("The cached version of script %d (\"%s\", \"uso:version\": %d) is the latest available.",
            scriptID, scriptName, aHeaders["uso:version"][0]);
        // Wait 30 minutes for the next metadata check
        script.updateMetaTimes(30);
        return res.send(script);
      }
      // Otherwise we need to send a new request...
      else {
        if (!script.isValid()) {
          logTime("Script %d (\"%s\") is not cached.  Requesting full script (\"uso:version\" %d)...",
              scriptID, scriptName, aHeaders["uso:version"]);
        }
        else {
          logTime("New version detected for script %d (\"%s\", old: \"%s\", new: \"%s\").  Requesting full script...",
              scriptID, scriptName, script.meta["uso:version"], aHeaders["uso:version"]);
        }

        // Attempt a full update
        uso.getScript(scriptID, function(aError, aResult) {
          if (404 === aError) {
            logTime("404 received for script %d", scriptID);
            // Wait 60 minutes if USO said the script couldn't be found
            script.updateMetaTimes(60);
            return res.send(404, {error: util.format("Script with ID %d was not found", scriptID)});
          }
          else if (aError) {
            logTime("Non-404 error for script %d: %s", scriptID, aError);
            // Wait 5 minutes if there was a non-404 error in retrieval
            script.updateMetaTimes(5);
            // Send the previous content if available
            if (script.isValid()) return res.send(script);
            return res.send(404, {error: "Invalid script request"});
          }

          // Successful new script retrieval... update the cache and send it along
          logTime("Successful response for script %d (\"%s\")", scriptID, scriptName);

          // Get a clean script
          script = SCRIPT_CACHE.set(scriptID, aResult.headers, aResult.content);

          // Add in useful headers (starting with "uso:") from the initial metadata request
          for (var i in aHeaders) if (0 === i.indexOf("uso:")) script.meta[i] = aHeaders[i][0];

          // Wait 30 minutes for the next metadata check
          script.updateMetaTimes(30);

          res.send(script);
        });
      }
    });
  }
});

// Static content
// TODO: this regexp is unbelievably bad... replace it
server.get(/^\/((?!(?:serving|uso|versioncheck)).)*$/, restify.serveStatic({
    directory: "./public"
  , default: "index.html"
  , maxAge: 300
}));


// Start listening
server.listen(process.env.PORT || 8080, function() {
  console.log("%s listening at %s", server.name, server.url);
});
