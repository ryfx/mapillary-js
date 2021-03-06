import {Observable} from "rxjs/Observable";
import {Subject} from "rxjs/Subject";
import {Subscription} from "rxjs/Subscription";

import "rxjs/add/operator/timeout";

import {EdgeDirection} from "../Edge";
import {
    Graph,
    GraphMode,
    GraphService,
    IEdgeStatus,
    Node,
    Sequence,
} from "../Graph";
import {
    IFrame,
    StateService,
} from "../State";

export class PlayService {
    private _graphService: GraphService;
    private _stateService: StateService;

    private _nodesAhead: number;
    private _playing: boolean;
    private _speed: number;

    private _direction$: Observable<EdgeDirection>;
    private _directionSubject$: Subject<EdgeDirection>;
    private _playing$: Observable<boolean>;
    private _playingSubject$: Subject<boolean>;
    private _speed$: Observable<number>;
    private _speedSubject$: Subject<number>;

    private _playingSubscription: Subscription;
    private _cacheSubscription: Subscription;
    private _clearSubscription: Subscription;
    private _graphModeSubscription: Subscription;
    private _stopSubscription: Subscription;

    constructor(graphService: GraphService, stateService: StateService) {
        this._graphService = graphService;
        this._stateService = stateService;

        this._directionSubject$ = new Subject<EdgeDirection>();
        this._direction$ = this._directionSubject$
            .startWith(EdgeDirection.Next)
            .publishReplay(1)
            .refCount();

        this._direction$.subscribe();

        this._playing = false;
        this._playingSubject$ = new Subject<boolean>();
        this._playing$ = this._playingSubject$
            .startWith(this._playing)
            .publishReplay(1)
            .refCount();

        this._playing$.subscribe();

        this._speed = 0.5;
        this._speedSubject$ = new Subject<number>();
        this._speed$ = this._speedSubject$
            .startWith(this._speed)
            .publishReplay(1)
            .refCount();

        this._speed$.subscribe();

        this._nodesAhead = this._mapNodesAhead(this._mapSpeed(this._speed));
    }

    public get playing(): boolean {
        return this._playing;
    }

    public get direction$(): Observable<EdgeDirection> {
        return this._direction$;
    }

    public get playing$(): Observable<boolean> {
        return this._playing$;
    }

    public get speed$(): Observable<number> {
        return this._speed$;
    }

    public play(): void {
        if (this._playing) {
            return;
        }

        this._stateService.cutNodes();
        const stateSpeed: number = this._setSpeed(this._speed);
        this._stateService.setSpeed(stateSpeed);

        this._graphModeSubscription = this._speed$
            .map(
                (speed: number): GraphMode => {
                    return speed > 0.54 ? GraphMode.Sequence : GraphMode.Spatial;
                })
            .distinctUntilChanged()
            .subscribe(
                (mode: GraphMode): void => {
                    this._graphService.setGraphMode(mode);
                });

        this._cacheSubscription = this._stateService.currentNode$
            .map(
                (node: Node): [string, string] => {
                    return [node.sequenceKey, node.key];
                })
            .distinctUntilChanged(
                undefined,
                ([sequenceKey, nodeKey]: [string, string]): string => {
                    return sequenceKey;
                })
            .combineLatest(
                this._graphService.graphMode$,
                this._direction$)
            .switchMap(
                ([[sequenceKey, nodeKey], mode, direction]: [[string, string], GraphMode, EdgeDirection]):
                    Observable<[Sequence, EdgeDirection]> => {

                    if (direction !== EdgeDirection.Next && direction !== EdgeDirection.Prev) {
                        return Observable.of<[Sequence, EdgeDirection]>([undefined, direction]);
                    }

                    const sequence$: Observable<Sequence> = (mode === GraphMode.Sequence ?
                        this._graphService.cacheSequenceNodes$(sequenceKey, nodeKey) :
                        this._graphService.cacheSequence$(sequenceKey))
                        .retry(3)
                        .catch(
                            (): Observable<Sequence> => {
                                return Observable.of(undefined);
                            });

                    return Observable
                        .combineLatest(
                            sequence$,
                            Observable.of(direction));
                })
            .switchMap(
                ([sequence, direction]: [Sequence, EdgeDirection]): Observable<string> => {
                    if (sequence === undefined) {
                        return Observable.empty();
                    }

                    const sequenceKeys: string[] = sequence.keys.slice();
                    if (direction === EdgeDirection.Prev) {
                        sequenceKeys.reverse();
                    }

                    return this._stateService.currentState$
                        .map(
                            (frame: IFrame): [string, number] => {
                                return [frame.state.trajectory[frame.state.trajectory.length - 1].key, frame.state.nodesAhead];
                            })
                        .scan(
                            (
                                [lastRequestKey, previousRequestKeys]: [string, string[]],
                                [lastTrajectoryKey, nodesAhead]: [string, number]):
                                [string, string[]] => {

                                if (lastRequestKey === undefined) {
                                    lastRequestKey = lastTrajectoryKey;
                                }

                                const lastIndex: number = sequenceKeys.length - 1;
                                if (nodesAhead >= this._nodesAhead || sequenceKeys[lastIndex] === lastRequestKey) {
                                    return [lastRequestKey, []];
                                }

                                const current: number = sequenceKeys.indexOf(lastTrajectoryKey);
                                const start: number = sequenceKeys.indexOf(lastRequestKey) + 1;
                                const end: number = Math.min(lastIndex, current + this._nodesAhead - nodesAhead) + 1;

                                if (end <= start) {
                                    return [lastRequestKey, []];
                                }

                                return [sequenceKeys[end - 1], sequenceKeys.slice(start, end)];
                            },
                            [undefined, []])
                        .mergeMap(
                            ([lastRequestKey, newRequestKeys]: [string, string[]]): Observable<string> => {
                                return Observable.from(newRequestKeys);
                            });
                })
            .mergeMap(
                (key: string): Observable<Node> => {
                    return this._graphService.cacheNode$(key)
                        .catch(
                            (): Observable<Node> => {
                                return Observable.empty();
                            });
                },
                6)
            .subscribe();

        this._playingSubscription = this._stateService.currentState$
            .filter(
                (frame: IFrame): boolean => {
                    return frame.state.nodesAhead < this._nodesAhead;
                })
            .map(
                (frame: IFrame): Node => {
                    return frame.state.lastNode;
                })
            .distinctUntilChanged(
                undefined,
                (lastNode: Node): string => {
                    return lastNode.key;
                })
            .withLatestFrom(this._direction$)
            .switchMap(
                ([node, direction]: [Node, EdgeDirection]): Observable<Node> => {
                    return ([EdgeDirection.Next, EdgeDirection.Prev].indexOf(direction) > -1 ?
                            node.sequenceEdges$ :
                            node.spatialEdges$)
                        .first(
                            (status: IEdgeStatus): boolean => {
                                return status.cached;
                            })
                        .timeout(15000)
                        .zip(Observable.of<EdgeDirection>(direction))
                        .map(
                            ([s, d]: [IEdgeStatus, EdgeDirection]): string => {
                                for (let edge of s.edges) {
                                    if (edge.data.direction === d) {
                                        return edge.to;
                                    }
                                }

                                return null;
                            })
                        .filter(
                            (key: string): boolean => {
                                return key != null;
                            })
                        .switchMap(
                            (key: string): Observable<Node> => {
                                return this._graphService.cacheNode$(key);
                            });
                })
            .subscribe(
                (node: Node): void => {
                    this._stateService.appendNodes([node]);
                },
                (error: Error): void => {
                    console.error(error);
                    this.stop();
                });

        this._clearSubscription = this._stateService.currentNode$
            .bufferCount(1, 10)
            .subscribe(
                (nodes: Node[]): void => {
                    this._stateService.clearPriorNodes();
                });

        this._setPlaying(true);

        this._stopSubscription = Observable
            .combineLatest(
                this._stateService.currentNode$,
                this._direction$)
            .switchMap(
                ([node, direction]: [Node, EdgeDirection]): Observable<[EdgeDirection, IEdgeStatus]> => {
                    const edgeStatus$: Observable<IEdgeStatus> = (
                        [EdgeDirection.Next, EdgeDirection.Prev].indexOf(direction) > -1 ?
                            node.sequenceEdges$ :
                            node.spatialEdges$)
                        .first(
                            (status: IEdgeStatus): boolean => {
                                return status.cached;
                            })
                        .timeout(15000)
                        .catch(
                            (error: Error): Observable<IEdgeStatus> => {
                                console.error(error);

                                return Observable.of<IEdgeStatus>({ cached: false, edges: [] });
                            });

                    return Observable
                        .combineLatest(
                            Observable.of(direction),
                            edgeStatus$);
                })
            .map(
                ([direction, edgeStatus]: [EdgeDirection, IEdgeStatus]): boolean => {
                    for (let edge of edgeStatus.edges) {
                        if (edge.data.direction === direction) {
                            return true;
                        }
                    }

                    return false;
                })
            .first(
                (hasEdge: boolean): boolean => {
                    return !hasEdge;
                })
            .subscribe(
                undefined,
                undefined,
                (): void => { this.stop(); });

        if (this._stopSubscription.closed) {
            this._stopSubscription = null;
        }
    }

    public setDirection(direction: EdgeDirection): void {
        this._directionSubject$.next(direction);
    }

    public setSpeed(speed: number): void {
        speed = Math.max(0, Math.min(1, speed));
        if (speed === this._speed) {
            return;
        }

        const stateSpeed: number = this._setSpeed(speed);

        if (this._playing) {
            this._stateService.setSpeed(stateSpeed);
        }

        this._speedSubject$.next(this._speed);
    }

    public stop(): void {
        if (!this._playing) {
            return;
        }

        if (!!this._stopSubscription) {
            if (!this._stopSubscription.closed) {
                this._stopSubscription.unsubscribe();
            }

            this._stopSubscription = null;
        }

        this._graphModeSubscription.unsubscribe();
        this._graphModeSubscription = null;

        this._cacheSubscription.unsubscribe();
        this._cacheSubscription = null;

        this._playingSubscription.unsubscribe();
        this._playingSubscription = null;

        this._clearSubscription.unsubscribe();
        this._clearSubscription = null;

        this._stateService.setSpeed(1);
        this._stateService.cutNodes();
        this._graphService.setGraphMode(GraphMode.Spatial);

        this._setPlaying(false);
    }

    private _mapSpeed(speed: number): number {
        const x: number = 2 * speed - 1;

        return Math.pow(10, x) - 0.2 * x;
    }

    private _mapNodesAhead(stateSpeed: number): number {
        return Math.round(Math.max(10, Math.min(50, 8 + 6 * stateSpeed)));
    }

    private _setPlaying(playing: boolean): void {
        this._playing = playing;
        this._playingSubject$.next(playing);
    }

    private _setSpeed(speed: number): number {
        this._speed = speed;
        const stateSpeed: number = this._mapSpeed(this._speed);
        this._nodesAhead = this._mapNodesAhead(stateSpeed);

        return stateSpeed;
    }
}

export default PlayService;
