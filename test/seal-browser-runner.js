/* jshint node: true */
/* global Promise: false */

// Headless Chrome driver for the browser QUnit suite (test/index.html).
//
// Usage (from the repository root, with the dist/ build present and the tree
// served with PHP on 127.0.0.1:8000, e.g. `node test/seal-php-pool.js`):
//
//   NODE_PATH=/path/to/node_modules node test/seal-browser-runner.js
//
// Environment:
//   CHROME_BIN        Chrome executable (default /usr/bin/google-chrome-stable)
//   SEAL_TEST_URL     suite URL (default
//                     http://127.0.0.1:8000/test/index.html?dev&hidepassed)
//                     "dev" loads the unminified dist/jquery.js under test.
//                     "hidepassed" keeps the QUnit report short: the whole
//                     suite runs in one page here (TestSwarm ran one module
//                     per page), and a long report keeps the window scrollable
//                     so the offset module's scrollTo( 1, 1 ) setup sticks and
//                     breaks "offset: hidden (display: none) element".
//   SEAL_TIMEOUT_MIN  global timeout in minutes (default 25)
//   SEAL_SKIP_TESTS   newline- or "|"-separated list of "module: test name"
//                     entries that are not registered with QUnit at all
//
// Exits non-zero when any assertion fails, when no test ran, or on timeout.

( function() {
"use strict";

var puppeteer = require( "puppeteer-core" ),

	chromeBin = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable",
	suiteUrl = process.env.SEAL_TEST_URL ||
		"http://127.0.0.1:8000/test/index.html?dev&hidepassed",
	timeoutMin = parseFloat( process.env.SEAL_TIMEOUT_MIN || "25" ),
	skipList = ( process.env.SEAL_SKIP_TESTS || "" )
		.split( /[\n|]/ )
		.map( function( entry ) {
			return entry.replace( /^\s+|\s+$/g, "" );
		} )
		.filter( function( entry ) {
			return entry.length > 0;
		} ),

	PREFIX = "__SEAL_QUNIT__",
	browser = null,
	finished = false,
	modules = {},
	moduleOrder = [],
	failedTests = [],
	skipped = [],
	stats = { tests: 0, assertions: 0, failed: 0, passed: 0, failedTests: 0 },
	currentFailures = [];

function out( line ) {
	process.stdout.write( line + "\n" );
}

function moduleEntry( name ) {
	if ( !modules.hasOwnProperty( name ) ) {
		modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failed: 0 };
		moduleOrder.push( name );
	}
	return modules[ name ];
}

function pad( value, width ) {
	value = String( value );
	while ( value.length < width ) {
		value += " ";
	}
	return value;
}

function padLeft( value, width ) {
	value = String( value );
	while ( value.length < width ) {
		value = " " + value;
	}
	return value;
}

function printSummary( qunitTotals ) {
	var i, name, entry;

	out( "" );
	out( "Per-module results:" );
	out( "  " + pad( "module", 16 ) + padLeft( "tests", 7 ) + padLeft( "failed", 8 ) +
		padLeft( "asserts", 9 ) + padLeft( "failed", 8 ) );
	for ( i = 0; i < moduleOrder.length; i++ ) {
		name = moduleOrder[ i ];
		entry = modules[ name ];
		out( "  " + pad( name || "(none)", 16 ) + padLeft( entry.tests, 7 ) +
			padLeft( entry.failedTests, 8 ) + padLeft( entry.assertions, 9 ) +
			padLeft( entry.failed, 8 ) );
	}

	if ( skipped.length ) {
		out( "" );
		out( "Excluded via SEAL_SKIP_TESTS (" + skipped.length + "):" );
		for ( i = 0; i < skipped.length; i++ ) {
			out( "  SKIP " + skipped[ i ] );
		}
	}

	if ( failedTests.length ) {
		out( "" );
		out( "Failed tests (" + failedTests.length + "):" );
		for ( i = 0; i < failedTests.length; i++ ) {
			out( "  FAIL " + failedTests[ i ] );
		}
	}

	out( "" );
	if ( qunitTotals ) {
		out( "QUnit totals: " + qunitTotals.total + " assertions, " + qunitTotals.failed +
			" failed, " + qunitTotals.passed + " passed in " + qunitTotals.runtime + "ms" );
	}
	out( stats.tests + " tests, " + stats.assertions + " assertions, " + stats.failed +
		" failed, " + stats.passed + " passed" );
}

function finish( code, reason, qunitTotals ) {
	if ( finished ) {
		return;
	}
	finished = true;

	if ( reason ) {
		out( "" );
		out( "RUNNER: " + reason );
	}
	printSummary( qunitTotals );

	if ( code === 0 && stats.tests === 0 ) {
		out( "RUNNER: no tests ran" );
		code = 1;
	}
	if ( code === 0 && ( stats.failed > 0 || stats.failedTests > 0 ) ) {
		code = 1;
	}
	out( code === 0 ? "RESULT: PASS" : "RESULT: FAIL" );

	var closing = browser ? browser.close() : Promise.resolve();
	closing.then( function() {
		process.exit( code );
	}, function() {
		process.exit( code );
	} );

	// Do not let a wedged browser keep the process alive
	setTimeout( function() {
		process.exit( code );
	}, 15000 );
}

function handleEvent( type, data ) {
	var entry, label, i;

	if ( type === "moduleStart" ) {
		out( "" );
		out( "# module: " + data.name );
	} else if ( type === "testStart" ) {
		currentFailures = [];
	} else if ( type === "log" ) {
		currentFailures.push( data );
	} else if ( type === "testDone" ) {
		label = data.module + ": " + data.name;
		entry = moduleEntry( data.module );
		entry.tests++;
		entry.assertions += data.total;
		entry.failed += data.failed;
		stats.tests++;
		stats.assertions += data.total;
		stats.failed += data.failed;
		stats.passed += data.passed;

		if ( data.failed > 0 ) {
			entry.failedTests++;
			stats.failedTests++;
			failedTests.push( label + " (" + data.passed + "/" + data.total + ")" );
			out( "FAIL " + label + " (" + data.passed + "/" + data.total + ")" );
			for ( i = 0; i < currentFailures.length; i++ ) {
				out( "    - " + ( currentFailures[ i ].message || "(no message)" ) );
				if ( currentFailures[ i ].hasExpected ) {
					out( "      expected: " + currentFailures[ i ].expected );
					out( "      actual:   " + currentFailures[ i ].actual );
				}
				if ( currentFailures[ i ].source ) {
					out( "      at: " + currentFailures[ i ].source.split( "\n" )[ 0 ] );
				}
			}
		} else {
			out( "ok " + label + " (" + data.passed + "/" + data.total + ")" );
		}
		currentFailures = [];
	} else if ( type === "skip" ) {
		label = data.module + ": " + data.name;
		skipped.push( label );
		out( "SKIP " + label + " (SEAL_SKIP_TESTS)" );
	} else if ( type === "done" ) {
		finish( 0, null, data );
	} else if ( type === "emitError" ) {
		out( "RUNNER: in-page reporter could not serialize an event" );
	}
}

// Runs inside every frame before any page script.
// Only the top frame (the suite page) reports; fixture iframes are ignored.
function pageHook( prefix, skipEntries ) {
	if ( window.top !== window ) {
		return;
	}

	// Snapshot natives: tests may replace window.JSON or console
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeConsole = window.console,
		nativeLog = nativeConsole.log,
		skipMap = {},
		realQUnit,
		hooked = false,
		i;

	for ( i = 0; i < skipEntries.length; i++ ) {
		skipMap[ skipEntries[ i ] ] = true;
	}

	function emit( type, data ) {
		var text;
		try {
			text = nativeStringify.call( nativeJSON, { t: type, d: data } );
		} catch ( e ) {
			text = "{\"t\":\"emitError\",\"d\":{}}";
		}
		try {
			nativeLog.call( nativeConsole, prefix + text );
		} catch ( e2 ) {}
	}

	function describe( value ) {
		var text;
		try {
			text = nativeStringify.call( nativeJSON, value );
		} catch ( e ) {
			text = undefined;
		}
		if ( text === undefined ) {
			try {
				text = String( value );
			} catch ( e3 ) {
				text = "(unprintable)";
			}
		}
		return text.length > 300 ? text.slice( 0, 300 ) + "..." : text;
	}

	function wrapTest( q, original ) {
		return function( testName ) {
			var moduleName = "";
			try {
				moduleName = q.config.currentModule ? q.config.currentModule.name : "";
			} catch ( e ) {}
			if ( skipMap[ moduleName + ": " + testName ] ) {
				emit( "skip", { module: moduleName, name: String( testName ) } );
				return;
			}
			return original.apply( this, arguments );
		};
	}

	function hook( q ) {
		if ( hooked || !q || !q.config ) {
			return;
		}
		hooked = true;

		q.config.reorder = false;

		if ( typeof q.test === "function" ) {
			q.test = wrapTest( q, q.test );
		}
		if ( typeof window.test === "function" ) {
			window.test = wrapTest( q, window.test );
		}
		if ( typeof window.asyncTest === "function" ) {
			window.asyncTest = wrapTest( q, window.asyncTest );
		}

		q.moduleStart( function( details ) {
			try {
				emit( "moduleStart", { name: String( details.name ) } );
			} catch ( e ) {}
		} );
		q.testStart( function( details ) {
			try {
				emit( "testStart", { module: String( details.module ), name: String( details.name ) } );
			} catch ( e ) {}
		} );
		q.log( function( details ) {
			try {
				if ( details.result ) {
					return;
				}
				emit( "log", {
					message: details.message ? String( details.message ) : "",
					hasExpected: details.hasOwnProperty( "expected" ),
					expected: describe( details.expected ),
					actual: describe( details.actual ),
					source: details.source ? String( details.source ) : ""
				} );
			} catch ( e ) {}
		} );
		q.testDone( function( details ) {
			try {
				emit( "testDone", {
					module: String( details.module ),
					name: String( details.name ),
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					runtime: details.runtime
				} );
			} catch ( e ) {}
		} );
		q.done( function( details ) {
			try {
				emit( "done", {
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					runtime: details.runtime
				} );
			} catch ( e ) {}
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return realQUnit;
		},
		set: function( value ) {
			realQUnit = value;
			hook( value );
		}
	} );
}

out( "Chrome: " + chromeBin );
out( "Suite:  " + suiteUrl );
out( "Global timeout: " + timeoutMin + " min" );
out( "Exclusions (" + skipList.length + "): " + ( skipList.length ? skipList.join( " | " ) : "none" ) );

setTimeout( function() {
	finish( 2, "global timeout of " + timeoutMin + " minutes reached" );
}, timeoutMin * 60 * 1000 );

puppeteer.launch( {
	executablePath: chromeBin,
	headless: true,
	args: [ "--no-sandbox", "--headless=new", "--window-size=1280,1024" ],
	defaultViewport: { width: 1280, height: 1024 },
	protocolTimeout: ( timeoutMin + 5 ) * 60 * 1000
} ).then( function( launched ) {
	browser = launched;
	return browser.version().then( function( version ) {
		out( "Browser: " + version );
		return browser.newPage();
	} );
} ).then( function( page ) {
	page.on( "console", function( msg ) {
		var text = msg.text(),
			payload;

		if ( text.indexOf( PREFIX ) !== 0 ) {
			return;
		}
		try {
			payload = JSON.parse( text.slice( PREFIX.length ) );
		} catch ( e ) {
			out( "RUNNER: unparsable reporter message: " + text.slice( 0, 200 ) );
			return;
		}
		handleEvent( payload.t, payload.d );
	} );
	page.on( "pageerror", function( err ) {
		out( "    [pageerror] " + String( err && err.message || err ).split( "\n" )[ 0 ] );
	} );
	page.on( "dialog", function( dialog ) {
		out( "    [dialog] " + dialog.type() + ": " + dialog.message() );
		dialog.dismiss()[ "catch" ]( function() {} );
	} );
	page.on( "error", function( err ) {
		finish( 3, "page crashed: " + ( err && err.message || err ) );
	} );
	browser.on( "disconnected", function() {
		finish( 3, "browser disconnected" );
	} );

	return page.evaluateOnNewDocument( pageHook, PREFIX, skipList ).then( function() {
		return page[ "goto" ]( suiteUrl, { waitUntil: "load", timeout: 120000 } );
	} );
} ).then( function( response ) {
	if ( response && !response.ok() ) {
		finish( 3, "suite page returned HTTP " + response.status() );
	}
} )[ "catch" ]( function( err ) {
	finish( 3, "runner error: " + ( err && err.stack || err ) );
} );

} )();
