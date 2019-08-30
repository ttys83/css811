const ccs = require('./ccs811').plugin();

ccs.flashFW()
	.catch(console.log);