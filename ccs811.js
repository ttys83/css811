/*

	Node.js driver for CCS811 sensor
	Andrew Shmelev (c) 2019

*/


exports.plugin = function() {

	const async = require('async');
	const i2c = require('i2c-bus');
	const fs = require('fs');

// I2C Address
	const CCS811_ADDR			=		0x5A;

// Registers
	const CCS811_HW_ID			=		0x20;
	const CCS811_STATUS			=		0x00;
	const CCS811_MEAS_MODE		=		0x01;
	const CCS811_ERROR_ID		=		0xE0;
	const CCS811_RAW_DATA		=		0x03;
	const CCS811_ALG_RESULT_DATA  =		0x02;
	const CCS811_BASELINE         =		0x11;
	const CCS811_ENV_DATA         =		0x05;
	const CCS811_FW_BOOT_VERSION  =		0x24;
	const CCS811_HW_VERSION		  =		0x21;

	const CCS811_APP_ERASE	  	=		0xF1;
	const CCS811_APP_DATA	 	=		0xF2;
	const CCS811_APP_VERIFY	  	=		0xF3;
	const CCS811_APP_START		=		0xF4;

	const CCS811_SW_RESET		=		0xFF;

	const CCS811_APP_ERASE_SEQ	=		Buffer.from([0xE7, 0xA7, 0xE6, 0x09]);
	const CCS811_SW_RESET_SEQ	  =		Buffer.from([0x11, 0xE5, 0x72, 0x8A]);

// Modes

	const CCS811_DRIVE_MODE_IDLE = 0x0;
	const CCS811_DRIVE_MODE_1SEC =  0x10;
	const CCS811_DRIVE_MODE_10SEC = 0x20;
	const CCS811_DRIVE_MODE_60SEC = 0x30;

	const ERROR = [
		'WRITE_REG_INVALID',
		'READ_REG_INVALID',
		'MEASMODE_INVALID',
		'MAX_RESISTANCE',
		'HEATER_FAULT',
		'HEATER_SUPPLY'
	];


	class Mutex {
		constructor () {
			this.queue = [];
			this.locked = false;
		}

		lock () {
			return new Promise((resolve, reject) => {
				if (this.locked) {
					this.queue.push([resolve, reject]);
				} else {
					this.locked = true;
					resolve();
				}
			});
		}

		release () {
			if (this.queue.length > 0) {
				const [resolve, reject] = this.queue.shift();
				resolve();
			} else {
				this.locked = false;
			}
		}
	}

	class ccs811 {

		constructor() {

			this.meas_cfg = CCS811_DRIVE_MODE_1SEC;

			this._startTime = process.uptime();
			this._baselineSaved = process.uptime();
			this._lastRead = null;		//Last reading time
			this._lastMeas = { eco2: null, tvoc: null, status: null };		//Last measurment result

			this._logfunc = (...args) => { process.stdout.write(args.join(" ")); }
			this._logprefix = 'CCS811:';
			this._logstr = '';
			this.log = (...args) => {
				if(this._logstr === "") this._logfunc("\x1b[31m\x1b[1m" + this._logprefix + "\x1b[0m ");
				this._logfunc(args.join(" ").trim() + "\n");
				this._logstr = "";
			}

			this.mutex = new Mutex();
			this.sensor_fault = false;

			this.mutex.lock();
			this._initHardware();
		}

		async _initHardwareOld() {
			return this.checkHWID()
				.then((data) => {
					if(data !== 0x81) throw new Error("Hardware id error!");
				})
				.then(() => {
					let i2c1;
					const cmdQueue = [
						(cb) => i2c1 = i2c.open(1, cb),
						(cb) => {
							i2c1.i2cWrite(CCS811_ADDR, 1, Buffer.from([CCS811_APP_START]), (err, bytesWritten, buffer) => {
								if (err) return cb(err);
								setTimeout(() => { cb(null, true) }, 20);
							});
						},
						(cb) => {
							i2c1.i2cWrite(CCS811_ADDR, 2, Buffer.from([CCS811_MEAS_MODE,this.meas_cfg]), (err, bytesWritten, buffer) => {
								if (err) return cb(err);
								setTimeout(() => { cb(null, true) }, 20);
							});
						},
						(cb) => i2c1.close(cb)
					];
					return new Promise((resolve,reject) => {
						async.series(cmdQueue, (err,results) => {
							if(err) {
								return reject(err);
							}
							resolve(results[2]);
						})
					})
				})
				.then(() => {
					this.log('Sensor ready.');
					return true;
				});
		}

		async _initHardware() {
			try {
				await this._checkHWID();
				await this.writeSensor(CCS811_APP_START,Buffer.alloc(0),true);
				await this.writeSensor(CCS811_MEAS_MODE,Buffer.from([this.meas_cfg]),true);
				this.sensor_fault = false;
				this.mutex.release();
				this.log('Sensor ready.');

			} catch(err) {
				setTimeout(() => {
					this.sensor_fault = true;
					this.log("Can't initialize sensor. " + err.message + ". Try again in two seconds...");
					this._initHardware();
				}, 2000);
			}
		}
		async _checkHWID() {
			return this.readSensor(CCS811_HW_ID,1,true)
				.then((data) => {
					if(data.readUInt8() !== 0x81) throw new Error('Hardware ID Error!');
					return true;
				})
		}

		async writeSensor(register, data=Buffer.alloc(0), on_init=false) {
		//register - type of int, data - type of Buffer
			let i2c1;
			const cmdQueue = [
				(cb) => i2c1 = i2c.open(1, cb),
				(cb) => {
					const regbuf = Buffer.from([register]);
					const bytes = regbuf.length + data.length;
					const buffer = Buffer.concat([regbuf, data], bytes)
// 					console.log('Write: ',register, data);
					i2c1.i2cWrite(CCS811_ADDR, bytes, buffer, (err, bytesWritten, buffer) => {
						if (err) return cb(err);
						setTimeout(() => { cb(null, true) }, 20);
					});
				},
				(cb) => i2c1.close(cb)
			];

			if(!on_init) await this.mutex.lock();

			return new Promise((resolve,reject) => {
				async.series(cmdQueue, (err,results) => {
					if(!on_init) this.mutex.release();
					if(err) return reject(err);
					resolve(results[1]);
				})
			})
		}
		async readSensor(register, bytes=1, on_init=false) {
			let i2c1;
			const cmdQueue = [
				(cb) => i2c1 = i2c.open(1, cb),
				(cb) => {
					i2c1.i2cWrite(CCS811_ADDR, 1, Buffer.from([register]), (err, bytesWritten, buffer) => {
						if (err) return cb(err);
						setTimeout(() => { cb(null, true) }, 20);
					});
				},
				(cb) => {
					i2c1.i2cRead(CCS811_ADDR, bytes, Buffer.alloc(bytes), (err, bytesRead, buffer) => {
						if (err) return cb(err);
						cb(null,buffer);
					});

				},
				(cb) => i2c1.close(cb)
			];

			if(!on_init) {
				if(this.sensor_fault) return Promise.reject(new Error('Sensor is not ready.'))
				await this.mutex.lock();
			}

			return new Promise((resolve,reject) => {
				async.series(cmdQueue, (err,results) => {
					if (err) {
						this.sensor_fault = true;
						if(!on_init) {
							this._initHardware();
						}
						return reject(err);
					};
					if(!on_init) this.mutex.release();
					resolve(results[2]);
				})
			})
		}

		async readStatus() {
			return this.readSensor(CCS811_STATUS)
				.then((data) => data.readUInt8(0));
		}

		async setCompensation(temperature, humidity) {

			if(temperature < -25) temperature = -25;
			if(temperature > 100) temperature = 100;
			if(humidity > 100) humidity = 100;
			if(humidity < 0) humidity = 0;

			temperature = temperature+25;

			const env = Buffer.alloc(4);
			env.writeUInt16BE(((humidity*512)|0), 0);
			env.writeUInt16BE(((temperature*512)|0), 2);

			return this.writeSensor(CCS811_ENV_DATA, env);
		}

		async readSensorData() {
			return this.readSensor(CCS811_ALG_RESULT_DATA, 5)
				.then(data => {
					const status = data.readUInt8(4);
					if((status & 0x8) === 0x8) {
						console.log(data);
						console.log(" " + data.readUInt16BE(0) + " " + data.readUInt16BE(2));
						return { eco2: data.readUInt16BE(0), tvoc: data.readUInt16BE(2) };
					}
					else return Promise.reject(new Error("CCS811: Data not ready!"));
				})
		}

		async readSensorDataOld() {

	/* Baseline handle
			if((process.uptime() - this._baselineSaved) > 86400) {
			if((process.uptime() - this._lastRead) > 1800 && this.checkCleanAir()) {
				console.log(process.uptime());
				this.readBaseLine()
					.then((data) => {
						fs.writeFile("BASELINE", data, (err) => {
							if(err) {
								return this.log(err.message);
							}
							this.log("File saved successfully!");
						})

					})
				this._baselineSaved = process.uptime();
			}
	*/
			const status = await this.readStatus()
			if(status & 0x8) return this.readSensor(CCS811_ALG_RESULT_DATA, 4)
				.then((data) => {
					this._lastRead = process.uptime();
					this._lastMeas = data;
					return {
						eco2: data.readUInt16BE(0),
						tvoc: data.readUInt16BE(2),
						ready: true
					}
				});
			else return { eco2: 0, tvoc: 0, ready: false };
		}
		async readECO2() {
			return this.readSensorData()
				.then(data => data.eco2);
		}
		async readTVOC() {
			return this.readSensorData()
				.then(data => data.tvoc);
		}

// Utils

		async readFirmwareVersion() {
			return this.readSensor(CCS811_FW_BOOT_VERSION,2)
				.then(data => (data.readUInt8(0) >>4).toString(10) + '.' + (data.readUInt8(0) & 0b00001111).toString(10) + '.' + data.readUInt8(1).toString(10))
		}
		async swReset() {
			await this.writeSensor(CCS811_SW_RESET, CCS811_SW_RESET_SEQ);
			console.log('Resetting...');
			await this.sleep(1000);
			console.log('Resetting done');
		}
		async swErase() {
			await this.writeSensor(CCS811_APP_ERASE, CCS811_APP_ERASE_SEQ);
			console.log('Erasing...');
			await this.sleep(1000);
			console.log('Erasing done');
		}
		async swVerify() {
			await this.writeSensor(CCS811_APP_VERIFY);
			console.log('Verifying...');
			await this.sleep(1000);
			await this.readStatus()
					.then(data => {
						if((data & 0x30) === 0x30) console.log('Verifying done');
						else console.log('Verifying fail!!!');
					})
		}
		async flashFW(fwfile = './CCS811_FW_App_v2-0-1.bin') {
			const fs = require('fs');
			const bufsize=8;

 			await this.swReset();
 			await this.swErase();

			let chunks = 0;

			const readStream = fs.createReadStream(fwfile, { highWaterMark: bufsize });

			readStream
				.on('readable', () => {
					let chunk;
					console.log('Open file');
					while (null !== (chunk = readStream.read())) {
 						this.writeSensor(CCS811_APP_DATA, chunk);
						console.log(chunk);
						bytes++;
					}
				})
				.on('end', () => {
					console.log('Burning in process: '+bytes+ ' chunks');
					console.log('Please wait....');
					this.swVerify();
				});

		}
		async readHWID() {
			return this.readSensor(CCS811_HW_ID,1)
				.then((data) => data.readUInt8(0))
		}
		async checkError() {
			const errorBit = ((await this.readStatus()) & 0b00000001);
			if(!errorBit) return false;
			return this.readSensor(CCS811_ERROR_ID,1)
				.then((data) => ERROR[data[0]]);
		}
		async configureSensor(config=this.meas_cfg) {
			console.log('Config sensor');
			const appstart = await this.writeSensor(CCS811_APP_START)
				.catch((err) => { console.log('Cannot write because of: ' + err.message) });
			if(typeof appstart === 'undefined') return Promise.reject(new Error('Appstart failed...'));

			return this.writeSensor(CCS811_MEAS_MODE, Buffer.from([config]));
		}
		async readMeasMode() {
			return this.readSensor(CCS811_MEAS_MODE)
				.then((data) => data.readUIntBE(0, 1));
		}
		async readRaw() {
			return this.readSensor(CCS811_RAW_DATA, 2)
				.then((data) => {
					const current = data.readUInt16BE(0) >> 10;
					const voltage = data.readUInt16BE(0) & 0b0000001111111111;
					return [current, voltage, data.readUInt16BE(0) ];
				});
		}
		async readBaseLine() {
			return this.readSensor(CCS811_BASELINE,2)
				.then((data) => data.readUInt16BE(0));
		}
		async setBaseLine(baseline) {
		//baseline - uint16
			return this.writeSensor(CCS811_BASELINE, Buffer.from([baseline]))
		}
		checkCleanAir() {
			const eco2 = this._lastMeas.eco2;
			const tvoc = this._lastMeas.tvoc;

			if((400 < eco2 < 450) && (1 < tvoc < 10)) return true;
			else return false;

		}
		async sleep(ms) {
			return new Promise((resolve, reject) => {
				setTimeout(() => {
					resolve();
				}, ms);
			})
		}
		getAbilities() {
			return ['eco2', 'tvoc'];
		}

	}

	return new ccs811();

}