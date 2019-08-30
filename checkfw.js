const ccs = require('./ccs811').plugin();

ccs.readFirmwareVersion()
	.then(console.log)
	.catch(console.error);
