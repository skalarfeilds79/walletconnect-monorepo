import { EventEmitter } from "events";
import pino, { Logger } from "pino";
import {
  IClient,
  ClientOptions,
  ClientTypes,
  ConnectionTypes,
  SessionTypes,
} from "@walletconnect/types";
import {
  formatUri,
  getAppMetadata,
  isConnectionFailed,
  isSessionFailed,
  parseUri,
  getLoggerOptions,
  formatLoggerContext,
} from "@walletconnect/utils";
import { JsonRpcPayload, JsonRpcRequest, isJsonRpcRequest } from "rpc-json-utils";

import { Store, Connection, Session, Relay } from "./controllers";
import {
  CLIENT_CONTEXT,
  CLIENT_EVENTS,
  CONNECTION_CONTEXT,
  CONNECTION_EVENTS,
  RELAY_DEFAULT_PROTOCOL,
  SESSION_CONTEXT,
  SESSION_EVENTS,
  SESSION_JSONRPC,
} from "./constants";

export class Client extends IClient {
  public readonly protocol = "wc";
  public readonly version = 2;

  public events = new EventEmitter();
  public logger: Logger;

  public store: Store;
  public relay: Relay;

  public connection: Connection;
  public session: Session;

  public context: string = CLIENT_CONTEXT;

  static async init(opts?: ClientOptions): Promise<Client> {
    const client = new Client(opts);
    await client.initialize();
    return client;
  }

  constructor(opts?: ClientOptions) {
    super(opts);
    const logger =
      typeof opts?.logger !== "undefined" && typeof opts?.logger !== "string"
        ? opts.logger
        : pino(getLoggerOptions(opts?.logger));
    this.context = opts?.overrideContext || this.context;
    this.logger = logger.child({
      context: this.context,
    });

    this.relay = new Relay(this.logger, opts?.relayProvider);
    this.store = opts?.store || new Store();

    this.connection = new Connection(this, this.logger);
    this.session = new Session(this, this.logger);
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public async connect(params: ClientTypes.ConnectParams): Promise<SessionTypes.Settled> {
    this.logger.info(`Connecting Application`);
    this.logger.debug({ type: "method", method: "connect", params });
    try {
      const connection =
        typeof params.connection === "undefined"
          ? await this.connection.create()
          : await this.connection.get(params.connection);
      this.logger.debug({ type: "method", method: "connect", connection });
      const session = await this.session.create({
        connection: { topic: connection.topic },
        relay: params.relay || { protocol: RELAY_DEFAULT_PROTOCOL },
        metadata: getAppMetadata(params.app),
        stateParams: {
          chains: params.chains,
        },
        ruleParams: {
          state: {
            accounts: {
              proposer: false,
              responder: true,
            },
          },
          jsonrpc: params.jsonrpc,
        },
      });
      this.logger.info(`Application Connection Successful`);
      this.logger.debug({ type: "method", method: "connect", session });
      return session;
    } catch (error) {
      this.logger.info(`Application Connection Failed`);
      this.logger.error(error);
      throw error;
    }
  }

  public async respond(params: ClientTypes.RespondParams): Promise<string | undefined> {
    if (typeof params.proposal === "string") {
      const uriParams = parseUri(params.proposal);
      this.logger.info(`Responding Connection Proposal`);
      this.logger.debug({ type: "method", method: "respond", params, uriParams });
      const responded = await this.connection.respond({
        approved: params.approved,
        proposal: {
          topic: uriParams.topic,
          peer: {
            publicKey: uriParams.publicKey,
          },
          relay: uriParams.relay,
        },
      });
      if (isConnectionFailed(responded.outcome)) {
        this.logger.info(`Connection Proposal Response Failure`);
        this.logger.warn({ type: "method", method: "respond", outcome: responded.outcome });
        return;
      }
      this.logger.info(`Connection Proposal Response Success`);
      this.logger.debug({ type: "method", method: "respond", responded });
      return responded.outcome.topic;
    }
    this.logger.info(`Responding Session Proposal`);
    this.logger.debug({ type: "method", method: "respond", params });
    if (typeof params.response === "undefined") {
      const errorMessage = "Response is required for session proposals";
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    const responded = await this.session.respond({
      approved: params.approved,
      proposal: params.proposal,
      metadata: getAppMetadata(params.response.app),
      state: params.response.state,
    });
    if (isSessionFailed(responded.outcome)) {
      this.logger.info(`Session Proposal Response Failure`);
      this.logger.warn({ type: "method", method: "respond", outcome: responded.outcome });
      return;
    }
    this.logger.info(`Session Proposal Response Success`);
    this.logger.debug({ type: "method", method: "respond", responded });
    return responded.outcome.topic;
  }

  public async disconnect(params: ClientTypes.DisconnectParams): Promise<void> {
    this.logger.debug({ type: "method", method: "disconnect", params });
    await this.session.delete(params);
  }

  // ---------- Protected ----------------------------------------------- //

  protected async onPayload(payload: JsonRpcPayload, context: string): Promise<void> {
    const eventName =
      context === CONNECTION_CONTEXT ? CONNECTION_EVENTS.payload : SESSION_EVENTS.payload;
    if (isJsonRpcRequest(payload)) {
      const request = payload as JsonRpcRequest;
      switch (request.method) {
        case SESSION_JSONRPC.propose:
          this.logger.info(`Emitting ${SESSION_EVENTS.proposed}`);
          this.logger.debug({
            type: "event",
            event: SESSION_EVENTS.proposed,
            data: request.params,
          });
          this.events.emit(SESSION_EVENTS.proposed, request.params);
          break;
        default:
          this.logger.info(`Emitting ${eventName}`);
          this.logger.debug({ type: "event", event: eventName, data: payload });
          this.events.emit(eventName, payload);
          break;
      }
    } else {
      this.logger.info(`Emitting ${eventName}`);
      this.logger.debug({ type: "event", event: eventName, data: payload });
      this.events.emit(eventName, payload);
    }
  }

  // ---------- Private ----------------------------------------------- //

  private async initialize(): Promise<any> {
    this.logger.trace({ type: "init" });
    try {
      await this.relay.init();
      await this.store.init();
      await this.connection.init();
      await this.session.init();
      this.registerEventListeners();
      this.logger.info(`Client initilization success`);
    } catch (error) {
      this.logger.info(`Client initilization failure`);
      this.logger.error(error);
      throw error;
    }
  }

  private registerEventListeners(): void {
    // Connection Subscription Events
    this.connection.on(CONNECTION_EVENTS.proposed, (proposed: ConnectionTypes.Proposed) => {
      this.logger.info(`Emitting ${CONNECTION_EVENTS.proposed}`);
      this.logger.debug({ type: "event", event: CONNECTION_EVENTS.proposed, data: proposed });
      this.events.emit(CONNECTION_EVENTS.proposed, proposed);
      const uri = formatUri({
        protocol: this.protocol,
        version: this.version,
        topic: proposed.topic,
        publicKey: proposed.keyPair.publicKey,
        relay: proposed.relay,
      });
      this.logger.debug({ type: "event", event: CLIENT_EVENTS.share_uri, uri });
      this.events.emit(CLIENT_EVENTS.share_uri, { uri });
    });
    this.connection.on(CONNECTION_EVENTS.responded, (responded: ConnectionTypes.Responded) => {
      this.logger.info(`Emitting ${CONNECTION_EVENTS.responded}`);
      this.logger.debug({ type: "event", event: CONNECTION_EVENTS.responded, data: responded });
      this.events.emit(CONNECTION_EVENTS.responded, responded);
    });
    this.connection.on(CONNECTION_EVENTS.settled, (connection: ConnectionTypes.Settled) => {
      this.logger.info(`Emitting ${CONNECTION_EVENTS.settled}`);
      this.logger.debug({ type: "event", event: CONNECTION_EVENTS.settled, data: connection });
      this.events.emit(CONNECTION_EVENTS.settled, connection);
    });
    this.connection.on(CONNECTION_EVENTS.updated, (connection: ConnectionTypes.Settled) => {
      this.logger.info(`Emitting ${CONNECTION_EVENTS.updated}`);
      this.logger.debug({ type: "event", event: CONNECTION_EVENTS.updated, data: connection });
      this.events.emit(CONNECTION_EVENTS.updated, connection);
    });
    this.connection.on(CONNECTION_EVENTS.deleted, (connection: ConnectionTypes.Settled) => {
      this.logger.info(`Emitting ${CONNECTION_EVENTS.deleted}`);
      this.logger.debug({ type: "event", event: CONNECTION_EVENTS.deleted, data: connection });
      this.events.emit(CONNECTION_EVENTS.deleted, connection);
    });
    this.connection.on(CONNECTION_EVENTS.payload, (payload: JsonRpcPayload) => {
      this.onPayload(payload, CONNECTION_CONTEXT);
    });
    // Session Subscription Events
    this.session.on(SESSION_EVENTS.proposed, (proposed: SessionTypes.Proposed) => {
      this.logger.info(`Emitting ${SESSION_EVENTS.proposed}`);
      this.logger.debug({ type: "event", event: SESSION_EVENTS.proposed, data: proposed });
      this.events.emit(SESSION_EVENTS.proposed, proposed);
    });
    this.session.on(SESSION_EVENTS.responded, (responded: SessionTypes.Responded) => {
      this.logger.info(`Emitting ${SESSION_EVENTS.responded}`);
      this.logger.debug({ type: "event", event: SESSION_EVENTS.responded, data: responded });
      this.events.emit(SESSION_EVENTS.responded, responded);
    });
    this.session.on(SESSION_EVENTS.settled, (session: SessionTypes.Settled) => {
      this.logger.info(`Emitting ${SESSION_EVENTS.settled}`);
      this.logger.debug({ type: "event", event: SESSION_EVENTS.settled, data: session });
      this.events.emit(SESSION_EVENTS.settled, session);
    });
    this.session.on(SESSION_EVENTS.updated, (session: SessionTypes.Settled) => {
      this.logger.info(`Emitting ${SESSION_EVENTS.updated}`);
      this.logger.debug({ type: "event", event: SESSION_EVENTS.updated, data: session });
      this.events.emit(SESSION_EVENTS.updated, session);
    });
    this.session.on(SESSION_EVENTS.deleted, (session: SessionTypes.Settled) => {
      this.logger.info(`Emitting ${SESSION_EVENTS.deleted}`);
      this.logger.debug({ type: "event", event: SESSION_EVENTS.deleted, data: session });
      this.events.emit(SESSION_EVENTS.deleted, session);
    });
    this.session.on(SESSION_EVENTS.payload, (payload: JsonRpcPayload) => {
      this.onPayload(payload, SESSION_CONTEXT);
    });
  }
}

export default Client;
