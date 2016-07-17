'use strict';
const utils = require('./lib/utils');

const pluginName = 'homebridge-pilight';
const accessoryName = 'pilight';

// TODO extract actual WebsocketClient usage into a dedicated stage
// => Observables API maybe?
// => Allowing multiplexing connections
const WebSocketConnectionFactory = require('./lib/ws');

module.exports = function (homebridge) {

  /**
   * pilight accessory via websocket
   */
  class PilightWebsocketAccessory {

    /**
     * Required config
     *
     * Default config is: host=localhost, port=5001, device=lamp
     *
     * @param log
     * @param config
     */
    constructor(log, config) {
      this.log = log;
      this.services = [];

      this.deviceState = undefined;
      this.dimLevel = undefined;

      this.config = {
        host : config.host || 'localhost',
        port : config.port || 5001,
        deviceId : config.device || 'lamp',
        name : config.name || config.device || 'Lamp',
        sharedWS : config.sharedWS || false,
        type : config.type || 'Switch'
      };

      this.id = `name=${this.config.deviceId},ws://${this.config.host}:${this.config.port}/`;
      this.name = config.name || this.config.device;

      this.connect();
    }

    connect() {
      const pilightSocketAddress = `ws://${this.config.host}:${this.config.port}/`;
      const connection = this.config.sharedWS
        ? WebSocketConnectionFactory.shared(this.log, {address : pilightSocketAddress})
        : WebSocketConnectionFactory.simple(this.log, {address : pilightSocketAddress});

      this.log(`Option sharedWS = ${this.config.sharedWS}`)

      this.connection = connection;
      connection.connect();

      // handle error
      connection.emitter.on('connection::error', (error) => {
        this.log(`Connection error: ${error.message}`);
      });

      connection.emitter.on('connection::create', () => {
        // initial request all available values
        this.log(`Requesting initial states...`);
        connection.send({action : 'request values'});
      });

      connection.emitter.on('message::receive', (body) => {
        this.handleMessage(body);
      });

      connection.emitter.on('message::error', (error) => {
        this.log(`Something went wrong, cannot parse message. Error: ${error.toString()}`);
      });
    }

    handleMessage(json) {
      if (utils.isMessageOfTypeValues(json)) {
        // bulk update ("request values")
        const item = json.find((item) => {
          return item.devices.indexOf(this.config.deviceId) !== -1;
        });
        if (item) {
          switch (this.config.type) {
            case "Dimmer":
              this.deviceState = item.values.state === 'on';
              this.dimLevel = item.values.dimlevel;
              this.log(`Initialized dimmer with state "${this.deviceState}" and dim level ${this.dimLevel}`);
              break;

            case "TemperatureSensor":
              this.deviceState = item.values.temperature;
              this.log(`Initialized temp sensor with temperature ${this.deviceState}`);
              break;

            default: // or Switch
              this.deviceState = item.values.state === 'on';
              this.log(`Initialized device with state "${this.deviceState}"`);
              break;
          }
        } else {
          this.log(`Could not find device with id "${this.config.deviceId}"`);
        }
      } else if (utils.isMessageOfTypeUpdate(json)) {
        // item update (after "control")
        if (json.devices.indexOf(this.config.deviceId) !== -1) {
          var service = this.getServiceForDevice(this.config.name);
          let characteristic = "";
          switch (this.config.type) {
            case "Dimmer":
              this.deviceState = json.values.state === 'on';
              service.getCharacteristic(homebridge.hap.Characteristic.On).setValue(this.deviceState);

              this.log(`Updated internal state to "${json.values.state}"`);

              if (json.values.dimlevel != undefined) {
                this.dimLevel = json.values.dimlevel;
                service.getCharacteristic(homebridge.hap.Characteristic.Brightness).setValue(this.deviceState);

                this.log(`Updated internal dim level to ${json.values.dimlevel}`);
              }
              break;

            case "TemperatureSensor":
              this.deviceState = json.values.temperature;
              service.getCharacteristic(homebridge.hap.Characteristic.CurrentTemperature).setValue(this.deviceState);

              this.log(`Updated internal temperature to ${json.values.temperature}`);
              break;

            default: // or Switch
              this.deviceState = json.values.state === 'on';
              service.getCharacteristic(homebridge.hap.Characteristic.On).setValue(this.deviceState);

              this.log(`Updated internal state to "${json.values.state}"`);
              break;
          }
        }
      }
    }

    getServiceForDevice(device) {
      return this.services.find(function (device, service) {
        return (service.displayName == device);
      }.bind(this, device));
    }
    
    getDimLevel(callback) {
      if (this.dimLevel === undefined) {
        this.log(`No dim level found`);
        callback(new Error('Not found'));
      } else {
        this.log(`Current dim level "${this.dimLevel}"`);
        callback(null, utils.dimlevelToBrightness(this.dimLevel));
      }
    }

    setDimLevel(brightness, callback) {
      if (!this.connection) {
        callback(new Error('No connection'));
      } else if (typeof(brightness) != "number") {
        callback(new Error('Not a brightness value'));
      } else if (brightness === 0) {
        callback(null);
      } else {
        const dimlevel = utils.brightnessToDimlevel(brightness);
        this.log(`Try to set dim level to ${dimlevel} for ${brightness}%`);
        this.connection.send({
          action : 'control',
          code : {
            device : this.config.deviceId,
            values : { dimlevel } 
          }
        });
        callback(null);
      }
    }
    
    getPowerState(callback) {
      if (this.deviceState === undefined) {
        this.log(`No power state found`);
        callback(new Error('Not found'));
      } else {
        callback(null, this.deviceState);
      }
    }

    setPowerState(powerOn, callback) {
      if (!this.connection) {
        callback(new Error('No connection'));      
      } else {
        const state = powerOn ? 'on' : 'off';
        this.log(`Try to set powerstate to "${state}"`);
        this.connection.send({
          action : 'control',
          code : {device : this.config.deviceId, state}
        });
        callback(null);
      }
    }

    getTemperature(callback) {
      if (this.deviceState === undefined) {
        this.log(`No temperature found`);
        callback(new Error('Not found'));
      } else {
        callback(null, this.deviceState);
      }
    }

    identify(callback) {
      this.log('Identify requested!');
      callback(); // success
    }

    getServices() {
      // TODO
      const informationService = new homebridge.hap.Service.AccessoryInformation()
        .setCharacteristic(homebridge.hap.Characteristic.Manufacturer, 'Pilight Manufacturer')
        .setCharacteristic(homebridge.hap.Characteristic.Model, 'Pilight Model')
        .setCharacteristic(homebridge.hap.Characteristic.SerialNumber, 'Pilight Serial Number');

      this.services.push(informationService);

      switch (this.config.type) {
        case 'Dimmer':
          let dimmerService = new homebridge.hap.Service.Lightbulb(this.config.name);
          dimmerService
            .getCharacteristic(homebridge.hap.Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));
          dimmerService
            .getCharacteristic(homebridge.hap.Characteristic.Brightness)
            .setProps({
              unit: null,
              minValue: 1,
              maxValue: 16
            })
            .on('get', this.getDimLevel.bind(this))
            .on('set', this.setDimLevel.bind(this));
          this.services.push(dimmerService);
          break;

        case 'Lamp':
          let lampService = new homebridge.hap.Service.Lightbulb(this.config.name);
          lampService
            .getCharacteristic(homebridge.hap.Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));
          this.services.push(lampService);
          break;

        case 'TemperatureSensor':
          let temperatureSensorService = new homebridge.hap.Service.TemperatureSensor(this.config.name);
          temperatureSensorService
            .getCharacteristic(homebridge.hap.Characteristic.CurrentTemperature)
            .on('get', this.getTemperature.bind(this));
          this.services.push(temperatureSensorService);
          break;
          
        default: // or Switch
          let switchService = new homebridge.hap.Service.Switch(this.config.name);
          switchService
            .getCharacteristic(homebridge.hap.Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));
          this.services.push(switchService);
          break;
      }
      return this.services;
    }
  }

  homebridge.registerAccessory(pluginName, accessoryName, PilightWebsocketAccessory);
};
