// LICENSE : MIT
"use strict";
// polyfill Object.assign
import * as assert from "assert";
import ObjectAssign from "./object-assign";
import LRU from "lru-map-like";
const CHANGE_STORE_GROUP = "CHANGE_STORE_GROUP";

import { Dispatcher } from "./../Dispatcher";
import { DispatchedPayload } from "./../Dispatcher";
import { DispatcherPayloadMetaImpl } from "./../DispatcherPayloadMeta";
import { Store } from "./../Store";
import { StoreLike } from "./../StoreLike";
import { StoreGroupValidator } from "./StoreGroupValidator";
import { isDidExecutedPayload } from "../payload/DidExecutedPayload";
import { isErrorPayload } from "../payload/ErrorPayload";
import { isCompletedPayload } from "../payload/CompletedPayload";

/**
 * QueuedStoreGroup options
 * @type {{asap: boolean}}
 * @private
 */
const defaultOptions = {
    /*
     As soon as possible option.

     If this is true, did executed UseCase and immediately try to call `emitChange()`
     It make that **child** UseCase change some Store and immediately reflect the changes to UI.

     If this is false,  did executed **root** UseCase and try to call `emitChange()`
     It means that **child** UseCase change some Store, but not immediately reflect the change to UI.
     Default: false
     */
    asap: false
};

export interface QueuedStoreGroupOption {
    asap?: boolean;
}

/**
 * ## Description
 *
 * - QueuedStoreGroup is a **UI** parts of Store.
 * - QueuedStoreGroup has event queue system.
 * - QueuedStoreGroup not dependent on async function like `setTimeout`.
 * - QueuedStoreGroup work as Sync or Async.
 * - QueuedStoreGroup prefer strict design than ./StoreGroup.js
 *
 * ## Checking Algorithm
 *
 * QueuedStoreGroup check changed stores and `QueuedStoreGroup#emitChange()` (if necessary) on following case:
 *
 * - when receive `didExecutedUseCase` events
 * - when receive events by `UseCase#dispatch`
 * - when receive events by `UseCase#throwError`
 *
 * ## Note
 *
 * - QueuedStoreGroup not allow to change **stores** directly.
 * - Always change **stores** via execution of UseCase.
 * - QueuedStoreGroup has not cache state.
 *  - Cache system should be in your Store.
 *
 * @public
 */
export class QueuedStoreGroup extends Dispatcher implements StoreLike {

    private _releaseHandlers: Array<Function>;
    private _currentChangingStores: Array<Store>;
    private stores: Array<Store>;
    private _stateCache: LRU<Store, any>;
    private _isAnyOneStoreChanged: boolean;

    /**
     * Create StoreGroup
     * @param {Store[]} stores stores are instance of `Store` class
     * @param {Object} [options] QueuedStoreGroup option
     * @public
     */
    constructor(stores: Array<Store>, options: QueuedStoreGroupOption = {}) {
        super();
        StoreGroupValidator.validateStores(stores);
        const asap = options.asap !== undefined ? options.asap : defaultOptions.asap;
        /**
         * callable release handlers
         * @type {Function[]}
         * @private
         */
        this._releaseHandlers = [];

        /**
         * array of store that emit change in now!
         * this array is temporary cache in changing the StoreGroup
         * @type {Store[]}
         * @private
         */
        this._currentChangingStores = [];
        /**
         * @type {Store[]}
         * @private
         */
        this.stores = stores;
        // listen onChange of each store.
        this.stores.forEach(store => this._registerStore(store));
        /**
         * LRU Cache for Store and State
         * @type {LRU}
         * @private
         */
        this._stateCache = new LRU<Store, any>(100);
        // `this` can catch the events of dispatchers
        // Because context delegate dispatched events to **this**
        const tryToEmitChange = (payload: DispatchedPayload, meta: DispatcherPayloadMetaImpl) => {
            // check stores, if payload's type is not system event.
            // It means that `onDispatch` is called when dispatching user event.
            if (!meta.isTrusted) {
                if (this.hasChangingStore) {
                    this.emitChange();
                }
            } else if (isErrorPayload(payload)) {
                if (this.hasChangingStore) {
                    this.emitChange();
                }
            } else if (isDidExecutedPayload(payload)) {
                const parent = meta.parentUseCase;
                // when {asap: false}, emitChange when root useCase is executed
                if (!asap && parent) {
                    return;
                }
                if (this.hasChangingStore) {
                    this.emitChange();
                }
            } else if (isCompletedPayload(payload)) {
                const parent = meta.parentUseCase;
                // when {asap: false}, emitChange when root useCase is executed
                if (!asap && parent) {
                    return;
                }
                if (this.hasChangingStore) {
                    this.emitChange();
                }
            }
        };
        const unListenOnDispatch = this.onDispatch(tryToEmitChange);
        this._releaseHandlers.push(unListenOnDispatch);
    }

    /**
     * Return true if has changing stores at least once
     * @returns {boolean}
     * @private
     */
    get hasChangingStore(): boolean {
        return this.currentChangingStores.length !== 0;
    }

    /**
     * Return current changing stores.
     * @returns {Store[]}
     * @private
     */
    get currentChangingStores(): Array<Store> {
        return this._currentChangingStores;
    }

    /**
     * return the state object that merge each stores's state
     * @returns {Object} merged state object
     * @public
     */
    getState<T>(): T {
        const stateMap = this.stores.map(store => {
            /*
             Why record nextState to `_storeValueMap`?
             It is for Use Store's getState(prevState) implementation.
             */
            const prevState = this._stateCache.get(store);
            const nextState = store.getState(prevState);
            if (process.env.NODE_ENV !== "production") {
                assert.ok(typeof nextState == "object", `${store}: ${store.name}.getState() should return Object.
e.g.)

 class ExampleStore extends Store {
     getState(prevState) {
         return {
            StateName: state
         };
     }
 }
 
Then, use can access by StateName.

StoreGroup#getState()["StateName"]; // state

`);
            }
            this._stateCache.set(store, nextState);
            return nextState;
        });
        return ObjectAssign({}, ...stateMap);
    }

    /**
     * register store and listen onChange.
     * If you release store, and do call {@link release} method.
     * @param {Store} store
     * @private
     */
    private _registerStore(store: Store) {
        // if anyone store is changed, will call `emitChange()`.
        const releaseOnChangeHandler = store.onChange(() => {
            // ====
            // prune previous cache
            if (!this._isAnyOneStoreChanged) {
                this._pruneCurrentChangingStores();
            }
            this._isAnyOneStoreChanged = true;
            // =====
            // if the same store emit multiple, emit only once.
            const isStoreAlreadyChanging = this._currentChangingStores.indexOf(store) !== -1;
            if (isStoreAlreadyChanging) {
                return;
            }
            // add change store list in now
            // it is released by `StoreGroup#emitChange`
            this._currentChangingStores.push(store);
        });
        // Implementation Note:
        // Delegate dispatch event to Store from StoreGroup
        // Dispatcher -> StoreGroup -> Store
        const releaseOnDispatchHandler = this.pipe(store);
        // add release handler
        this._releaseHandlers = this._releaseHandlers.concat([releaseOnChangeHandler, releaseOnDispatchHandler]);
    }

    /**
     * emit change event
     * @public
     */
    emitChange(): void {
        if (!this._isAnyOneStoreChanged) {
            return;
        }
        const changingStores = this._currentChangingStores.slice();
        // release ownership  of changingStores from StoreGroup
        // transfer ownership of changingStores to other
        this.emit(CHANGE_STORE_GROUP, changingStores);
        // reset changed state flag
        this._isAnyOneStoreChanged = false;
    }

    /**
     * listen changes of the store group.
     * @param {function(stores: Store[])} handler the callback arguments is array of changed store.
     * @returns {Function} call the function and release handler
     * @public
     */
    onChange(handler: (stores: Array<Store>) => void ): () => void {
        this.on(CHANGE_STORE_GROUP, handler);
        const releaseHandler = this.removeListener.bind(this, CHANGE_STORE_GROUP, handler);
        this._releaseHandlers.push(releaseHandler);
        return releaseHandler;
    }

    /**
     * release all events handler.
     * You can call this when no more call event handler
     * @public
     */
    release(): void {
        this._releaseHandlers.forEach(releaseHandler => releaseHandler());
        this._releaseHandlers.length = 0;
        this._stateCache.clear();
    }

    /**
     * prune changing stores
     * @private
     */
    private _pruneCurrentChangingStores(): void {
        this._currentChangingStores.length = 0;
    }
}
