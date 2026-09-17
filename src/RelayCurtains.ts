import type { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { EventEmitter } from 'events';
import type { Device } from 'smart-bus';

import { HDLBusproHomebridge } from './HDLPlatform';
import { ABCDevice, ABCListener } from './ABC';

const HMBOpening = 1;
const HMBClosing = 0;
const HMBStop = 2;

// Slider drags arrive as a burst of writes; only act on the last one.
const SET_DEBOUNCE_MS = 400;
// ponytail: fixed pause before reversing a running relay motor. Raise it if your
// modules trip on direction changes.
const REVERSE_PAUSE_MS = 500;

export class RelayCurtains implements ABCDevice {
  private service: Service;
  private RelayCurtainsStates = {
    PositionState: HMBStop,
    CurrentPosition: 0,
    TargetPosition: 0,
  };

  private postracker_process;
  private stopper_process;
  private debounce_process;
  private reverse_process;
  // HDL direction we believe the motor is running in, null when stopped.
  private moving: number | null = null;
  private HDLOpening = 1;
  private HDLClosing = 2;
  private HDLStop = 0;

  constructor(
    private readonly platform: HDLBusproHomebridge,
    private readonly accessory: PlatformAccessory,
    private readonly name: string,
    private readonly controller: Device,
    private readonly device: Device,
    private readonly listener: RelayCurtainListener,
    private readonly channel: number,
    private readonly nc: boolean,
    private readonly duration: number,
    private readonly precision: number,
  ) {
    const Service = this.platform.Service;
    const Characteristic = this.platform.Characteristic;

    // Initialize from persisted context
    this.RelayCurtainsStates.CurrentPosition = accessory.context.currentPosition ?? 0;
    this.RelayCurtainsStates.TargetPosition = accessory.context.targetPosition ?? 0;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'HDL');
    this.service = this.accessory.getService(Service.WindowCovering) || this.accessory.addService(Service.WindowCovering);
    this.service.setCharacteristic(Characteristic.Name, name);

    this.service.getCharacteristic(Characteristic.CurrentPosition)
      .onGet(this.handleCurrentPositionGet.bind(this));
    this.service.getCharacteristic(Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));
    this.service.getCharacteristic(Characteristic.TargetPosition)
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));

    if (this.nc === false) {
      this.HDLOpening = 2;
      this.HDLClosing = 1;
      this.HDLStop = 0;
    }

    const eventEmitter = this.listener.getCurtainEventEmitter(this.channel);
    eventEmitter.on('update', (status) => {
      if (status === this.HDLStop) {
        this.endMove();
        return;
      }
      if (status !== this.HDLOpening && status !== this.HDLClosing) {
        return;
      }
      // Already tracking this motion (our own move, or a repeated status broadcast).
      if (this.moving === status) {
        return;
      }
      // Nobody asked us for this, so it came from a wall switch or a scene: full travel.
      const opening = status === this.HDLOpening;
      this.platform.log.debug(`${this.name} started moving externally, assuming full ${opening ? 'open' : 'close'}`);
      this.beginMove(opening ? 100 : 0, opening);
    });

    // Query current state from hardware
    this.controller.send({
      target: this.device,
      command: 0xE3E2,
      data: { curtain: this.channel },
    }, () => undefined);
  }

  private saveCurrentPosition() {
    this.accessory.context.currentPosition = this.RelayCurtainsStates.CurrentPosition;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private saveTargetPosition() {
    this.accessory.context.targetPosition = this.RelayCurtainsStates.TargetPosition;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private sendStatus(status: number) {
    this.controller.send({
      target: this.device,
      command: 0xE3E0,
      data: { curtain: this.channel, status: status },
    }, (err) => {
      if (err) {
        this.platform.log.error(`Error sending curtain command for ${this.name}: ${err.message}`);
        this.endMove();
      }
    });
  }

  // Start tracking a move that is (about to be) running on the bus.
  private beginMove(target: number, opening: boolean) {
    const Characteristic = this.platform.Characteristic;
    clearInterval(this.postracker_process);
    clearTimeout(this.stopper_process);

    this.moving = opening ? this.HDLOpening : this.HDLClosing;
    this.RelayCurtainsStates.TargetPosition = target;
    this.service.getCharacteristic(Characteristic.TargetPosition).updateValue(target);
    this.saveTargetPosition();
    this.RelayCurtainsStates.PositionState = opening ? HMBOpening : HMBClosing;
    this.service.getCharacteristic(Characteristic.PositionState).updateValue(this.RelayCurtainsStates.PositionState);

    // duration is the full-travel time in seconds, so one percent takes duration * 10 ms.
    this.postracker_process = setInterval(() => {
      const next = this.RelayCurtainsStates.CurrentPosition + (opening ? 1 : -1);
      if (next < 0 || next > 100) {
        return;
      }
      this.RelayCurtainsStates.CurrentPosition = next;
      this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(next);
    }, 10 * this.duration);

    if (target === 0 || target === 100) {
      this.platform.log.debug(`Full ${opening ? 'open' : 'close'} of ${this.name} from ${this.RelayCurtainsStates.CurrentPosition}%`);
      return; // let the module's own limit switch stop it
    }

    const pathtogo = Math.abs(target - this.RelayCurtainsStates.CurrentPosition);
    this.platform.log.debug(`Partial ${opening ? 'open' : 'close'} of ${this.name} from ${this.RelayCurtainsStates.CurrentPosition}% to ${target}%`);
    this.stopper_process = setTimeout(() => {
      this.sendStatus(this.HDLStop);
      this.platform.log.debug(`Reached ${target}% on ${this.name}`);
    }, 1000 * (pathtogo / 100) * this.duration);
  }

  // The motor has stopped (bus said so, or we gave up on it).
  private endMove() {
    const Characteristic = this.platform.Characteristic;
    clearInterval(this.postracker_process);
    clearTimeout(this.stopper_process);
    this.moving = null;

    const states = this.RelayCurtainsStates;
    if (Math.abs(states.CurrentPosition - states.TargetPosition) <= this.precision) {
      states.CurrentPosition = states.TargetPosition; // absorb HDL/HB timer lag
    } else {
      states.TargetPosition = states.CurrentPosition; // stopped early, by a switch or a scene
    }
    states.PositionState = HMBStop;
    this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(states.CurrentPosition);
    this.service.getCharacteristic(Characteristic.TargetPosition).updateValue(states.TargetPosition);
    this.service.getCharacteristic(Characteristic.PositionState).updateValue(states.PositionState);
    this.platform.log.debug(`${this.name} stopped at ${states.CurrentPosition}%`);
    this.saveCurrentPosition();
    this.saveTargetPosition();
  }

  private applyTarget(target: number) {
    const current = this.RelayCurtainsStates.CurrentPosition;
    if (target === current) {
      if (this.moving !== null) {
        this.sendStatus(this.HDLStop);
      }
      return;
    }

    const opening = target > current;
    const direction = opening ? this.HDLOpening : this.HDLClosing;
    const go = () => {
      this.beginMove(target, opening);
      this.sendStatus(direction);
    };

    if (this.moving !== null && this.moving !== direction) {
      clearInterval(this.postracker_process); // freeze the reported position while we pause
      clearTimeout(this.stopper_process);
      this.sendStatus(this.HDLStop);
      this.reverse_process = setTimeout(go, REVERSE_PAUSE_MS);
    } else {
      go();
    }
  }

  async handleTargetPositionSet(targetposition: CharacteristicValue) {
    this.RelayCurtainsStates.TargetPosition = targetposition as number;
    this.saveTargetPosition();
    clearTimeout(this.debounce_process);
    clearTimeout(this.reverse_process);
    this.debounce_process = setTimeout(() => this.applyTarget(targetposition as number), SET_DEBOUNCE_MS);
  }

  async handleTargetPositionGet(): Promise<CharacteristicValue> {
    return this.RelayCurtainsStates.TargetPosition;
  }

  async handleCurrentPositionGet(): Promise<CharacteristicValue> {
    return this.RelayCurtainsStates.CurrentPosition;
  }

  async handlePositionStateGet(): Promise<CharacteristicValue> {
    return this.RelayCurtainsStates.PositionState;
  }
}

export class RelayCurtainListener implements ABCListener {
  private curtainsMap = new Map();
  private eventEmitter = new EventEmitter();

  constructor(
    private readonly device: Device,
    private readonly controller: Device,
  ) {
    this.device.on(0xE3E1, (command) => {
      const data = command.data;
      const curtain = data.curtain;
      const status = data.status;
      this.curtainsMap.set(curtain, status);
      this.eventEmitter.emit(`update_${curtain}`, status);
    });
    this.device.on(0xE3E3, (command) => {
      const data = command.data;
      const curtain = data.curtain;
      const status = data.status;
      this.curtainsMap.set(curtain, status);
      this.eventEmitter.emit(`update_${curtain}`, status);
    });
    this.device.on(0xE3E4, (command) => {
      const data = command.data;
      if (!Array.isArray(data.curtains)) {
        return;
      }
      for (const curtainInfo of data.curtains) {
        const curtain = curtainInfo.number;
        const status = curtainInfo.status;
        this.curtainsMap.set(curtain, status);
        this.eventEmitter.emit(`update_${curtain}`, status);
      }
    });
  }

  getCurtainEventEmitter(curtain: number) {
    const eventEmitter = new EventEmitter();
    this.eventEmitter.on(`update_${curtain}`, (status) => {
      eventEmitter.emit('update', status);
    });
    return eventEmitter;
  }
}
