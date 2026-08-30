import { Keychain } from './keychain';

export async function getConfigValue(key: string): Promise<string | null> {
  return Keychain.get(key);
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  await Keychain.set(key, value);
}
