import { hasNextcloudTransport, hasSignalTransport, type Config } from "../config.js";
import type { Transport } from "../transport.js";
import { NextcloudTransport } from "./nextcloud.js";
import { SignalTransport } from "./signal.js";

/** Construct all enabled transports. */
export function createTransports(config: Config): Transport[] {
  const transports: Transport[] = [];

  if (hasSignalTransport(config) && config.signalPhoneNumber) {
    transports.push(
      new SignalTransport(
        config.signalCliUrl,
        config.signalPhoneNumber,
        config.bridgeDataDir,
      ),
    );
  }

  if (hasNextcloudTransport(config)) {
    transports.push(new NextcloudTransport(config.nextcloud));
  }

  if (transports.length === 0) {
    throw new Error("No enabled transports after config parsing");
  }

  return transports;
}
