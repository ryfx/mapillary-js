/// <reference path="../../typings/index.d.ts" />

import {Subject} from "rxjs/Subject";

import {MockCreator} from "./MockCreator.spec";
import {MockCreatorBase} from "./MockCreatorBase.spec";

import {EdgeDirection} from "../../src/Edge";
import {PlayService} from "../../src/Viewer";

export class PlayServiceMockCreator extends MockCreatorBase<PlayService> {
    public create(): PlayService {
        const mock: PlayService = new MockCreator().create(PlayService, "PlayService");

        this._mockProperty(mock, "direction$", new Subject<EdgeDirection>());
        this._mockProperty(mock, "playing$", new Subject<boolean>());

        return mock;
    }
}

export default PlayServiceMockCreator;
