/* jshint node: true */

// Serves the repository for the browser QUnit suite: an HTTP front on
// 127.0.0.1:8000 dispatching to a pool of single-process `php -S` backends,
// at most ONE in-flight request per backend.
//
// Why not `PHP_CLI_SERVER_WORKERS=N php -S` directly: each php -S worker can
// accept several connections at once but serves them one after another. When
// a slow fixture (core/dont_return.php sleeps 30s, name.php?wait=10) and a
// second request land on the same worker, the second one stalls behind the
// sleep and timing-based tests such as
// "core: document ready when jQuery loaded asynchronously (#13655)" fail.
//
// Usage (from the repository root):
//   node test/seal-php-pool.js
//
// Environment:
//   PHP_BIN          php executable (default "php")
//   SEAL_PHP_POOL    number of backends (default 16)
//   SEAL_PHP_PORT    front port (default 8000)
//   SEAL_PHP_BASE    first backend port (default 18000)

( function() {
"use strict";

var http = require( "http" ),
	spawn = require( "child_process" ).spawn,

	phpBin = process.env.PHP_BIN || "php",
	poolSize = parseInt( process.env.SEAL_PHP_POOL || "16", 10 ),
	frontPort = parseInt( process.env.SEAL_PHP_PORT || "8000", 10 ),
	basePort = parseInt( process.env.SEAL_PHP_BASE || "18000", 10 ),
	docRoot = process.cwd(),

	backends = [],
	waiting = [],
	children = [],
	i;

function log( line ) {
	process.stdout.write( "[php-pool] " + line + "\n" );
}

function startBackend( index ) {
	var port = basePort + index,
		env = {},
		key,
		child;

	for ( key in process.env ) {
		if ( process.env.hasOwnProperty( key ) && key !== "PHP_CLI_SERVER_WORKERS" ) {
			env[ key ] = process.env[ key ];
		}
	}

	child = spawn( phpBin, [ "-S", "127.0.0.1:" + port, "-t", docRoot ], {
		env: env,
		stdio: [ "ignore", "ignore", "ignore" ]
	} );
	child.on( "exit", function( code, signal ) {
		log( "backend " + port + " exited (" + ( signal || code ) + ")" );
	} );
	children.push( child );
	backends.push( { port: port, busy: false, served: 0 } );
}

function rawToHeaders( raw ) {
	var headers = {},
		j, name, value;

	for ( j = 0; j < raw.length; j += 2 ) {
		name = raw[ j ];
		value = raw[ j + 1 ];
		if ( headers.hasOwnProperty( name ) ) {
			headers[ name ] = [].concat( headers[ name ], value );
		} else {
			headers[ name ] = value;
		}
	}
	return headers;
}

function release( backend ) {
	var next;

	backend.busy = false;
	next = waiting.shift();
	if ( next ) {
		dispatch( next.req, next.res, backend );
	}
}

function dispatch( req, res, backend ) {
	var released = false,
		upstream;

	function done() {
		if ( !released ) {
			released = true;
			release( backend );
		}
	}

	backend.busy = true;
	backend.served++;

	upstream = http.request( {
		host: "127.0.0.1",
		port: backend.port,
		method: req.method,
		path: req.url,
		headers: rawToHeaders( req.rawHeaders ),
		agent: false
	}, function( upRes ) {
		var headers = [],
			j;

		for ( j = 0; j < upRes.rawHeaders.length; j += 2 ) {
			headers.push( [ upRes.rawHeaders[ j ], upRes.rawHeaders[ j + 1 ] ] );
		}
		try {
			res.writeHead( upRes.statusCode, upRes.statusMessage, headers );
		} catch ( e ) {
			res.writeHead( upRes.statusCode, headers );
		}
		upRes.pipe( res );
	} );

	// The backend is free only once php has finished the request, even when
	// the browser aborted it earlier (php keeps sleeping regardless).
	upstream.on( "close", done );
	upstream.on( "error", function( err ) {
		if ( !res.headersSent ) {
			res.writeHead( 502, { "Content-Type": "text/plain" } );
		}
		res.end( "php-pool upstream error: " + err.message );
		done();
	} );

	req.pipe( upstream );
}

function onRequest( req, res ) {
	var j;

	for ( j = 0; j < backends.length; j++ ) {
		if ( !backends[ j ].busy ) {
			dispatch( req, res, backends[ j ] );
			return;
		}
	}
	waiting.push( { req: req, res: res } );
}

function shutdown() {
	var j;

	for ( j = 0; j < children.length; j++ ) {
		children[ j ].kill( "SIGTERM" );
	}
	process.exit( 0 );
}

for ( i = 0; i < poolSize; i++ ) {
	startBackend( i );
}

process.on( "SIGTERM", shutdown );
process.on( "SIGINT", shutdown );

// Give the backends a moment to bind before accepting traffic
setTimeout( function() {
	http.createServer( onRequest ).listen( frontPort, "127.0.0.1", function() {
		log( "serving " + docRoot + " on http://127.0.0.1:" + frontPort + " via " +
			poolSize + " php -S backends (ports " + basePort + "-" +
			( basePort + poolSize - 1 ) + ")" );
	} );
}, 1500 );

} )();
