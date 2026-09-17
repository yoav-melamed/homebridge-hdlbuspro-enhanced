import type { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import type { Device } from 'smart-bus';

import { HDLBusproHomebridge } from './HDLPlatform';
import { RelayListener } from './RelayLightbulb';
import { ABCDevice } from './ABC';


const HMBOpen = 0;
const HMBClosed = 1;

export class RelayLock implements ABCDevice {
  private service: Service;
  private RelayLockStates = {
    Lock: HMBClosed,
    Target: HMBClosed,
  };

  constructor(
    private readonly platform: HDLBusproHomebridge,
    private readonly accessory: PlatformAccessory,
    private readonly name: string,
    private readonly controller: Device,
    private readonly device: Device,
    private readonly listener: RelayListener,
    private readonly channel: number,
    private readonly nc: boolean,
    private readonly lock_timeout: number,
  ) {
    const Service = this.platform.Service;
    const Characteristic = this.platform.Characteristic;
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'HDL');
    this.service =
    this.accessory.getService(Service.LockMechanism) || this.accessory.addService(Service.LockMechanism);
    this.service.setCharacteristic(Characteristic.Name, name);
    this.service.getCharacteristic(Characteristic.LockCurrentState)
      .onGet(this.handleLockCurrentStateGet.bind(this));
    this.service.getCharacteristic(Characteristic.LockTargetState)
      .onSet(this.handleLockTargetStateSet.bind(this))
      .onGet(this.handleLockTargetStateGet.bind(this));

    const eventEmitter = this.listener.getChannelEventEmitter(this.channel);
    eventEmitter.on('update', (level) => {
      if (this.nc) {
        this.RelayLockStates.Lock = (level === 0 ? HMBClosed : HMBOpen);
      } else {
        this.RelayLockStates.Lock = (level === 0 ? HMBOpen : HMBClosed);
      }
      this.service.getCharacteristic(Characteristic.LockCurrentState).updateValue(this.RelayLockStates.Lock);
      if (this.RelayLockStates.Lock === HMBClosed) {
        this.platform.log.debug(this.name + ' is now closed');
      } else {
        this.platform.log.debug(this.name + ' is now open');
      }
    });
  }

  async handleLockTargetStateSet(value: CharacteristicValue) {
    const target = value as number;
    const oldValue = this.RelayLockStates.Target;
    this.RelayLockStates.Target = target;
    let level = target;
    this.service.getCharacteristic(this.platform.Characteristic.LockTargetState).updateValue(this.RelayLockStates.Target);
    if (this.nc) {
      level = target === 0 ? 1 : 0;
    }
    this.controller.send({
      target: this.device,
      command: 0x0031,
      data: { channel: this.channel, level: level * 100 },
    }, (err) => {
      if (err) {
        // Revert to the old value
        this.RelayLockStates.Target = oldValue;
        this.service.getCharacteristic(this.platform.Characteristic.LockTargetState).updateValue(this.RelayLockStates.Target);
        this.platform.log.error(`Error setting LockTarget state for ${this.device.name}: ${err.message}`);
      } else {
        this.platform.log.debug('Successfully sent command to ' + this.name);
        if ((target === HMBOpen) && (this.lock_timeout > 0)) {
          setTimeout(() => {
            this.handleLockTargetStateSet(HMBClosed);
          }, 1000 * this.lock_timeout);
        }
      }
    });
  }

  async handleLockCurrentStateGet(): Promise<CharacteristicValue> {
    return this.RelayLockStates.Lock;
  }

  async handleLockTargetStateGet(): Promise<CharacteristicValue> {
    return this.RelayLockStates.Target;
  }
}