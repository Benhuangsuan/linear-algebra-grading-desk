import metadata from '../package.json' with {type:'json'};
/** Package metadata is the sole source for the running application's version. */
export const APP_VERSION=metadata.version;
