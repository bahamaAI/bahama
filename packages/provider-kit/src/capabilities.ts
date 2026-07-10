/**
 * Capabilities are the only way providers connect. A provider declares what
 * its resources produce (`connectionUrl`) and what they consume
 * (`productionEnvironment`); the core engine wires declared edges. Providers
 * never import or know about each other.
 */

export interface CapabilitySpec {
  /** Capability name within the resource, e.g. `connectionUrl`, `productionUrl`. */
  capability: string;
  /** True when the produced value is a secret and must stay sealed. */
  secret: boolean;
  description: string;
}

/**
 * Address of a produced capability inside a project:
 * `resources.database.connectionUrl` → { resourceKey: "database", capability: "connectionUrl" }.
 * The application is addressed with the reserved key `application`.
 */
export interface CapabilityAddress {
  resourceKey: string;
  capability: string;
}

/**
 * A resolved binding edge. Classification keys on this edge: the same
 * destination name fed from a DIFFERENT source resource is a consequential
 * rewiring, not a routine refresh.
 */
export interface BindingEdge {
  /** Destination name, e.g. the environment variable `DATABASE_URL`. */
  name: string;
  from: CapabilityAddress;
  to: CapabilityAddress;
  secret: boolean;
}
