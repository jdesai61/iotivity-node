var QUnit, suites,
	glob = require( "glob" ),
	_ = require( "underscore" ),
	childProcess = require( "child_process" ),
	fs = require( "fs" ),
	path = require( "path" ),
	uuid = require( "uuid" ),
	runningProcesses = [],
	getQUnit = function() {
		if ( !QUnit ) {
			QUnit = require( "./setup" );
		}
		return QUnit;
	};

function havePromises() {
	var nodeVersion = _.map(
		process.versions.node.split( "." ),
		function( item ) { return +item; } );

	return ( nodeVersion.length > 1 &&
		( nodeVersion[ 0 ] > 0 ||
		nodeVersion[ 0 ] === 0 && nodeVersion[ 1 ] > 11 ) );
}

// Spawn a single child and process its stdout.
function spawnOne( assert, options ) {
	var theChild = childProcess.spawn(
		"node",
		[ options.path ].concat( options.uuid ? [ options.uuid ] : [] ),
		{
			stdio: [ process.stdin, "pipe", process.stderr ]
		} );

	theChild.commandLine = "node" + " " + options.path + " " + options.uuid;
	runningProcesses.push( theChild );

	theChild
		.on( "exit", function( code, signal ) {
			var exitCodeOK = ( code === 0 || code === null ),
				signalOK = ( signal !== "SIGSEGV" );

			assert.ok( exitCodeOK, options.name + " exited successfully (" + code + ")" );
			assert.ok( signalOK, options.name + " did not segfault" );
		} )
		.on( "close", function() {
			var childIndex = runningProcesses.indexOf( theChild );
			if ( childIndex >= 0 ) {
				runningProcesses.splice( childIndex, 1 );
			}
			options.maybeQuit( theChild );
		} );

	// The stdout of the child is a sequence of \n-separated stringified JSON objects.
	theChild.stdout.on( "data", function serverStdoutData( data ) {
		_.each( data.toString().split( "\n" ), function( value ) {
			var jsonObject;

			if ( !value ) {
				return;
			}

			// Attempt to retrieve a JSON object from stdout.
			try {
				jsonObject = JSON.parse( value );
			} catch ( e ) {
				options.teardown( "Error parsing " + options.name + " JSON: '" + value + "'" +
					( e.message ? e.message : e ), true );
			}

			// The child is reporting the number of assertions it will be making. We add our own
			// two assertions ( 1.) successful exit and 2.) no segfault) to that count.
			if ( jsonObject.assertionCount ) {
				options.reportAssertions( jsonObject.assertionCount + 2 );

			// The child has requested a teardown.
			} else if ( jsonObject.teardown ) {
				options.teardown(
					options.name + " requested teardown: " + jsonObject.message );

			// The child has requested that its peer be killed.
			} else if ( jsonObject.killPeer ) {
				options.teardown( null, theChild );

			// The child is reporting that it is ready. Only servers do this.
			} else if ( jsonObject.ready ) {
				if ( options.onReady ) {
					options.onReady();
				}

			// The child is making an assertion.
			} else if ( jsonObject.assertion ) {
				assert[ jsonObject.assertion ].apply( assert, jsonObject.arguments );

			// Otherwise, we have received unknown JSON from the child - bail.
			} else {
				options.teardown( "Unkown JSON from " + options.name + ": " + value, true );
			}
		} );
	} );

	return theChild;
}

function runTestSuites( files ) {
	_.each( files, function( item ) {
		var clientPathIndex,
			clientPaths = glob.sync( path.join( item, "client*.js" ) ),
			serverPath = path.join( item, "server.js" );

		if ( fs.lstatSync( item ).isFile() ) {
			getQUnit().test( path.basename( item ).replace( /\.js$/, "" ), function( assert ) {
				var theChild,
					spawnOptions = {
						uuid: uuid.v4(),
						name: "Test",
						path: item,
						teardown: function( error ) {
							if ( theChild ) {
								theChild.kill( "SIGTERM" );
							}
						},
						maybeQuit: assert.async(),
						reportAssertions: _.bind( assert.expect, assert )
					};
				theChild = spawnOne( assert, spawnOptions );
			} );
			return;
		}

		if ( !fs.lstatSync( item ).isDirectory() ) {
			return;
		}

		for ( clientPathIndex in clientPaths ) {
			if ( !( fs.lstatSync( clientPaths[ clientPathIndex ] ).isFile() ) ) {
				throw new Error( "Cannot find client at " + clientPaths[ cllientPathIndex ] );
			}
		}

		if ( !( fs.lstatSync( serverPath ).isFile() ) ) {
			throw new Error( "Cannot find server at " + serverPath );
		}

		getQUnit().test( path.basename( item ), function( assert ) {
			var totalChildren = clientPaths.length + 1,

				// Track the child processes involved in this test in this array
				children = [],

				// When killing child processes in a loop we have to copy the array because it may
				// become modified by the incoming notifications that a process has exited.
				copyChildren = function() {
					var index,
						theCopy = [];

					for ( index in children ) {
						theCopy.push( children[ index ] );
					}

					return theCopy;
				},

				// Turn this test async
				done = assert.async(),

				// Count assertions made by the children. Report them to assert.expect() when both
				// children have reported their number of assertions.
				totalAssertions = 0,
				childrenAssertionsReported = 0,

				spawnOptions = {
					uuid: uuid.v4(),
					teardown: function( error, sourceProcess ) {
						var index,
							signal = error ? "SIGTERM" : "SIGINT",
							copyOfChildren = copyChildren();

						for ( index in copyOfChildren ) {
							if ( sourceProcess && sourceProcess === copyOfChildren[ index ] ) {
								continue;
							}
							copyOfChildren[ index ].kill( signal );
						}

						if ( error ) {
							throw new Error( error );
						}
					},
					maybeQuit: function( theChild ) {
						var childIndex = children.indexOf( theChild );
						if ( childIndex >= 0 ) {
							children.splice( childIndex, 1 );
						}
						if ( children.length === 0 ) {
							done();
						}
					},
					reportAssertions: function( assertionCount ) {
						childrenAssertionsReported++;
						totalAssertions += assertionCount;
						if ( childrenAssertionsReported == totalChildren ) {
							assert.expect( totalAssertions );
						}
					}
				};

			// We run the server first, because the server has to be there before the clients
			// can run. OTOH, the clients may initiate the termination of the test via a non-error
			// teardown request.
			children.push( spawnOne( assert, _.extend( {}, spawnOptions, {
				name: "server",
				path: serverPath,
				onReady: function() {
					var clientPathIndex;

					for ( clientPathIndex in clientPaths ) {
						children.push( spawnOne( assert, _.extend( {}, spawnOptions, {
							name: "client" +
								( clientPaths.length > 1 ? " " + clientPathIndex : "" ),
						path: clientPaths[ clientPathIndex ] } ) ) );
					}
				}
			} ) ) );
		} );
	} );
}

// Run tests. If no tests were specified on the command line, we scan the tests directory and run
// all the tests we find therein.
runTestSuites( ( ( process.argv.length > 2 ) ?
	( _.map( process.argv[ 2 ].split( "," ), function( item ) {
		return path.join( __dirname, "tests", item );
	} ) ) :
	( glob.sync( path.join( __dirname, "tests", ( havePromises() ? "" : "!(API)" ) + "*" ) ) ) ) );

process.on( "exit", function() {
	var childIndex;

	for ( childIndex in runningProcesses ) {
		runningProcesses[ childIndex ].kill( "SIGTERM" );
	}
} );
