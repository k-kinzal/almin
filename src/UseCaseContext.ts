// LICENSE : MIT
"use strict";

import { UseCase } from "./UseCase";
import { UseCaseExecutor } from "./UseCaseExecutor";

const assert = require("assert");
/**
 * UseCase internally use UseCaseContext insteadof Context.
 * It has limitation as against to Context.
 * Because, UseCaseContext is for UseCase.
 * @public
 */
export class UseCaseContext {

    dispatcher: UseCase;

    /**
     * @param   dispatcher
     *  The parent UseCase.
     */
    constructor(dispatcher: UseCase) {
        this.dispatcher = dispatcher;
    }

    /**
     * Create UseCaseExecutor for `useCase`.
     * @param   useCase
     */
    useCase(useCase: UseCase): UseCaseExecutor {
        if (process.env.NODE_ENV !== "production") {
            assert(useCase !== this.dispatcher, `the useCase(${useCase}) should not equal this useCase(${this.dispatcher})`);
        }
        return new UseCaseExecutor({
            useCase,
            parent: this.dispatcher,
            dispatcher: this.dispatcher
        });
    }
}