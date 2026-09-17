// Smoke check for the accessory wiring, run with `npm test`.
//
// HDLPlatform builds every accessory positionally
// (platform, accessory, name, controller, device, listener, ...uniqueArgs),
// so a constructor whose parameters drift out of step silently receives the
// wrong values instead of failing. This drives real discovery against stubbed
// homebridge/smart-bus objects and asserts what actually lands on the bus.
const assert = require('node:assert/strict');

// The accessories arm 1s pollers and relock timers; record them instead of
// letting them run, so the checks stay deterministic and the process exits.
const timers = [];
global.setInterval = () => ({});
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, delay) => {
  timers.push({ fn, delay });
  return {};
};
global.clearTimeout = () => {};
global.clearInterval = () => {};
void realSetTimeout;

// --- stub smart-bus before HDLPlatform requires it -------------------------
const sent = [];
const smartBusPath = require.resolve('smart-bus');
let bus = null;
function FakeBus() {
  this.devices = {};
  bus = this;
}
FakeBus.prototype.device = function (address) {
  return (this.devices[address] ??= {
    address, name: address, handlers: new Map(),
    on(code, fn) {
      if (!this.handlers.has(code)) {
        this.handlers.set(code, []);
      }
      this.handlers.get(code).push(fn);
    },
    emit(code, command) {
      for (const fn of this.handlers.get(code) ?? []) {
        fn(command);
      }
    },
  });
};
FakeBus.prototype.controller = function (address) {
  return {
    address,
    on() {},
    send(options, callback) {
      sent.push(options);
      if (typeof callback === 'function') {
        callback(null);
      }
    },
  };
};
require.cache[smartBusPath] = {
  id: smartBusPath, filename: smartBusPath, loaded: true, exports: FakeBus,
};

// --- stub homebridge's HAP -------------------------------------------------
// Real numeric values for the constants the accessories branch on; everything
// else is an interned marker object, which is all getCharacteristic() needs.
const Characteristic = intern({
  ContactSensorState: { CONTACT_DETECTED: 1, CONTACT_NOT_DETECTED: 0 },
  LeakDetected: { LEAK_NOT_DETECTED: 0, LEAK_DETECTED: 1 },
  SmokeDetected: { SMOKE_NOT_DETECTED: 0, SMOKE_DETECTED: 1 },
  OccupancyDetected: { OCCUPANCY_NOT_DETECTED: 0, OCCUPANCY_DETECTED: 1 },
});
const Service = intern({});

function intern(known) {
  const cache = new Map(Object.entries(known));
  return new Proxy({}, {
    get(_target, key) {
      if (!cache.has(key)) {
        cache.set(key, { __name: key });
      }
      return cache.get(key);
    },
  });
}

function makeService(type) {
  const characteristics = new Map();
  return {
    type,
    characteristic(key) {
      if (!characteristics.has(key)) {
        characteristics.set(key, {
          key, value: undefined, props: undefined, handlers: {},
          onGet(fn) {
            this.handlers.get = fn; return this;
          },
          onSet(fn) {
            this.handlers.set = fn; return this;
          },
          setProps(props) {
            this.props = props; return this;
          },
          updateValue(value) {
            this.value = value; return this;
          },
        });
      }
      return characteristics.get(key);
    },
    getCharacteristic(key) {
      return this.characteristic(key);
    },
    setCharacteristic(key, value) {
      this.characteristic(key).value = value; return this;
    },
    updateCharacteristic(key, value) {
      this.characteristic(key).value = value; return this;
    },
  };
}

function makeAccessory(displayName, UUID) {
  const services = new Map();
  return {
    displayName, UUID, context: {},
    getService(type) {
      return services.get(type);
    },
    addService(type) {
      const service = makeService(type);
      services.set(type, service);
      return service;
    },
    service(type) {
      return services.get(type) ?? this.addService(type);
    },
  };
}

const logged = [];
const log = {
  info: (...a) => logged.push(['info', ...a]),
  debug: (...a) => logged.push(['debug', ...a]),
  warn: (...a) => logged.push(['warn', ...a]),
  error: (...a) => logged.push(['error', ...a]),
};

const registered = [];
const api = {
  hap: { Service, Characteristic, uuid: { generate: (id) => `uuid:${id}` } },
  on() {},
  platformAccessory: function (name, uuid) {
    const accessory = makeAccessory(name, uuid);
    // AccessoryInformation is present on a real accessory from the start.
    accessory.addService(Service.AccessoryInformation);
    return accessory;
  },
  registerPlatformAccessories: (_p, _n, accessories) => registered.push(...accessories),
  updatePlatformAccessories: () => {},
};

// --- run discovery ---------------------------------------------------------
const { HDLBusproHomebridge } = require('../dist/HDLPlatform');

function discover(devices) {
  sent.length = 0;
  registered.length = 0;
  timers.length = 0;
  bus = null;
  const platform = new HDLBusproHomebridge(log, {
    name: 'test',
    buses: [{
      bus_IP: '192.0.2.1', bus_port: 6000,
      subnets: [{ subnet_number: 1, cd_number: 254, devices }],
    }],
  }, api);
  platform.discoverDevices();
  return registered;
}

// 1. Heater: channel must be the configured channel, not the listener object.
{
  const [accessory] = discover([{
    device_name: 'Floor', device_type: 'relayheater', device_address: 10,
    channel: 3, minTemperature: 16, maxTemperature: 30, defaultTemperature: 21,
  }]);
  const thermostat = accessory.service(Service.Thermostat);
  thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState).handlers.set(1);

  const control = sent.find((s) => s.command === 0xE3E0);
  assert.ok(control, 'heater sent no control command');
  assert.equal(control.data.channel, 3, 'heater channel must come from config, not the listener');
  assert.deepEqual(
    thermostat.getCharacteristic(Characteristic.TargetTemperature).props,
    { minValue: 16, maxValue: 30, minStep: 0.5 },
    'heater must honour the configured temperature limits',
  );
}

// 2. Fan: switching on at speed 0 must not send level 0.
{
  const [accessory] = discover([{
    device_name: 'Vent', device_type: 'relayfan', device_address: 11, channel: 4,
  }]);
  const fan = accessory.service(Service.Fan);
  fan.getCharacteristic(Characteristic.On).handlers.set(true);

  const write = sent.find((s) => s.command === 0x0031);
  assert.ok(write.data.level > 0, `fan turned on must send a non-zero level, got ${write.data.level}`);
}

// 3. Lock: the auto-relock timer must arm on unsecure for both circuit types.
for (const nc of [true, false]) {
  const [accessory] = discover([{
    device_name: 'Door', device_type: 'relaylock', device_address: 12,
    channel: 5, nc, lock_timeout: 3600,
  }]);
  const lock = accessory.service(Service.LockMechanism);
  lock.getCharacteristic(Characteristic.LockTargetState).handlers.set(0); // 0 = unsecured
  const relock = timers.filter((t) => t.delay === 1000 * 3600);
  assert.equal(relock.length, 1, `relock timer must arm for nc=${nc}`);
}

// 4. Leak sensor must publish on LeakDetected, not ContactSensorState.
{
  const [accessory] = discover([{
    device_name: 'Sink', device_type: 'drycontact', drycontact_type: 'leaksensor',
    device_address: 13, area: 1, channel: 6, nc: true,
  }]);
  const leak = accessory.service(Service.LeakSensor);
  // Replay a dry-contact frame through the listener the platform built.
  bus.device('1.13').emit(0x15CF, { data: { area: 1, switch: 6, contact: true } });
  assert.equal(
    leak.getCharacteristic(Characteristic.LeakDetected).value,
    Characteristic.LeakDetected.LEAK_DETECTED,
    'leak state must reach the LeakDetected characteristic',
  );
}

// 5. Curtains: a partial target must stay partial. The old code re-derived intent
// from the module's status echo, so a 40% request came back as a full open.
{
  const [accessory] = discover([{
    device_name: 'Blind', device_type: 'relaycurtains', device_address: 14,
    channel: 1, nc: true, duration: 10, curtains_precision: 10,
  }]);
  const covering = accessory.service(Service.WindowCovering);
  const target = covering.getCharacteristic(Characteristic.TargetPosition);

  target.handlers.set(40); // from the persisted 0%
  timers.splice(0).filter((t) => t.delay === 400).forEach((t) => t.fn()); // slider debounce
  const move = sent.find((s) => s.command === 0xE3E0);
  assert.equal(move.data.status, 1, 'partial open must command the opening direction');

  // The module echoes "opening"; that echo is our own move, not a wall switch.
  bus.device('1.14').emit(0xE3E1, { data: { curtain: 1, status: 1 } });
  assert.equal(target.value, 40, `partial target must survive the status echo, got ${target.value}`);
  const stopper = timers.filter((t) => t.delay === 0.4 * 10 * 1000);
  assert.equal(stopper.length, 1, 'a stop must be armed for 40% of the travel time');

  // An unsolicited "closing" (wall switch) is a full travel, so no stop is armed.
  timers.length = 0;
  bus.device('1.14').emit(0xE3E1, { data: { curtain: 1, status: 2 } });
  assert.equal(target.value, 0, 'a wall-switch close must track to 0%');
  assert.equal(timers.length, 0, 'a full travel must let the limit switch stop it');
}

console.log('smoke checks passed');
