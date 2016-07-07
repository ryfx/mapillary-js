/// <reference path="../../../typings/index.d.ts" />

import * as rx from "rx";
import * as vd from "virtual-dom";

import {
    Component,
    ComponentService,
    ISequenceConfiguration,
    SequenceDOMRenderer,
    SequenceDOMInteraction,
} from "../../Component";
import {EdgeDirection} from "../../Edge";
import {Node} from "../../Graph";
import {IVNodeHash} from "../../Render";
import {IFrame} from "../../State";
import {Container, Navigator} from "../../Viewer";

interface IConfigurationOperation {
    (configuration: ISequenceConfiguration): ISequenceConfiguration;
}

/**
 * @class SequenceComponent
 * @classdesc Component showing navigation arrows for sequence directions
 * as well as playing button. Exposes an API to start and stop play.
 */
export class SequenceComponent extends Component {
    /** @inheritdoc */
    public static componentName: string = "sequence";

    /**
     * Event fired when playing starts or stops.
     *
     * @event PlayerComponent#playingchanged
     * @type {boolean} Indicates whether the player is playing.
     */
    public static playingchanged: string = "playingchanged";

    private _sequenceDOMRenderer: SequenceDOMRenderer;
    private _sequenceDOMInteraction: SequenceDOMInteraction;
    private _nodesAhead: number = 5;

    private _configurationOperation$: rx.Subject<IConfigurationOperation> = new rx.Subject<IConfigurationOperation>();
    private _hoveredKeySubject$: rx.Subject<string>;
    private _hoveredKey$: rx.Observable<string>;
    private _containerWidth$: rx.Subject<number>;

    private _configurationSubscription: rx.IDisposable;
    private _renderSubscription: rx.IDisposable;
    private _containerWidthSubscription: rx.IDisposable;
    private _hoveredKeySubscription: rx.IDisposable;

    private _playingSubscription: rx.IDisposable;
    private _stopSubscription: rx.IDisposable;

    constructor(name: string, container: Container, navigator: Navigator) {
        super(name, container, navigator);

        this._sequenceDOMRenderer = new SequenceDOMRenderer(container.element);
        this._sequenceDOMInteraction = new SequenceDOMInteraction();

        this._containerWidth$ = new rx.Subject<number>();
        this._hoveredKeySubject$ = new rx.Subject<string>();

        this._hoveredKey$ = this._hoveredKeySubject$.share();
    }

   /**
    * Get default configuration.
    *
    * @returns {ISequenceConfiguration}
    */
    public get defaultConfiguration(): ISequenceConfiguration {
        return {
            direction: EdgeDirection.Next,
            maxWidth: 117,
            minWidth: 70,
            playing: false,
            visible: true,
        };
    }

    /**
     * Get hovered key observable.
     *
     * @description An observable emitting the key of the node for the direction
     * arrow that is being hovered. When the mouse leaves a direction arrow null
     * is emitted.
     *
     * @returns {Observable<string>}
     */
    public get hoveredKey$(): rx.Observable<string> {
        return this._hoveredKey$;
    }

    /**
     * Start playing.
     *
     * @fires PlayerComponent#playingchanged
     */
    public play(): void {
        this.configure({ playing: true });
    }

    /**
     * Stop playing.
     *
     * @fires PlayerComponent#playingchanged
     */
    public stop(): void {
        this.configure({ playing: false });
    }

    /**
     * Set the direction to follow when playing.
     *
     * @param {EdgeDirection} direction - The direction that will be followed when playing.
     */
    public setDirection(direction: EdgeDirection): void {
        this.configure({ direction: direction });
    }

    /**
     * Set highlight key.
     *
     * @description The arrow pointing towards the node corresponding to the
     * highlight key will be highlighted.
     *
     * @param {string} highlightKey Key of node to be highlighted if existing.
     */
    public setHighlightKey(highlightKey: string): void {
        this.configure({ highlightKey: highlightKey });
    }

    /**
     * Set max width of container element.
     *
     * @description Set max width of the container element holding
     * the sequence navigation elements. If the min width is larger than the
     * max width the min width value will be used.
     *
     * The container element is automatically resized when the resize
     * method on the Viewer class is called.
     *
     * @param {number} minWidth
     */
    public setMaxWidth(maxWidth: number): void {
        this.configure({ maxWidth: maxWidth });
    }

    /**
     * Set min width of container element.
     *
     * @description Set min width of the container element holding
     * the sequence navigation elements. If the min width is larger than the
     * max width the min width value will be used.
     *
     * The container element is automatically resized when the resize
     * method on the Viewer class is called.
     *
     * @param {number} minWidth
     */
    public setMinWidth(minWidth: number): void {
        this.configure({ minWidth: minWidth });
    }

    /**
     * Set the value indicating whether the sequence UI elements should be visible.
     *
     * @param {boolean} visible
     */
    public setVisible(visible: boolean): void {
        this.configure({ visible: visible });
    }

    /** @inheritdoc */
    public resize(): void {
        this._configuration$
            .first()
            .map<number>(
                (configuration: ISequenceConfiguration): number => {
                    return this._sequenceDOMRenderer.getContainerWidth(
                        this._container.element,
                        configuration);
                })
            .subscribe(
                (containerWidth: number): void => {
                    this._containerWidth$.onNext(containerWidth);
                });
    }

    protected _activate(): void {
        this._renderSubscription = rx.Observable
            .combineLatest(
                this._navigator.stateService.currentNode$,
                this._configuration$,
                this._containerWidth$,
                (node: Node, configuration: ISequenceConfiguration, containerWidth: number):
                [Node, ISequenceConfiguration, number] => {
                    return [node, configuration, containerWidth];
                })
            .map<IVNodeHash>(
                (nc: [Node, ISequenceConfiguration, number]): IVNodeHash => {
                    let node: Node = nc[0];
                    let configuration: ISequenceConfiguration = nc[1];
                    let containerWidth: number = nc[2];

                    let vNode: vd.VNode = this._sequenceDOMRenderer
                        .render(
                            node,
                            configuration,
                            containerWidth,
                            this,
                            this._sequenceDOMInteraction,
                            this._navigator);

                    return {name: this._name, vnode: vNode };
                })
            .subscribe(this._container.domRenderer.render$);

        this._containerWidthSubscription = this._configuration$
            .distinctUntilChanged(
                (configuration: ISequenceConfiguration) => {
                    return [configuration.minWidth, configuration.maxWidth];
                },
                (value1: [number, number], value2: [number, number]): boolean => {
                    return value1[0] === value2[0] && value1[1] === value2[1];
                })
            .map<number>(
                (configuration: ISequenceConfiguration): number => {
                    return this._sequenceDOMRenderer.getContainerWidth(
                        this._container.element,
                        configuration);
                })
            .subscribe(this._containerWidth$);

        this._configurationSubscription = this._configurationOperation$
            .scan<ISequenceConfiguration>(
                (configuration: ISequenceConfiguration, operation: IConfigurationOperation): ISequenceConfiguration => {
                    return operation(configuration);
                },
                { playing: false })
            .finally(
                (): void => {
                    if (this._playingSubscription != null) {
                        this._navigator.stateService.cutNodes();
                        this._stop();
                    }
                })
            .subscribe();

        this._configuration$
            .map<IConfigurationOperation>(
                (newConfiguration: ISequenceConfiguration) => {
                    return (configuration: ISequenceConfiguration): ISequenceConfiguration => {
                        if (newConfiguration.playing !== configuration.playing) {

                            this._navigator.stateService.cutNodes();

                            if (newConfiguration.playing) {
                                this._play();
                            } else {
                                this._stop();
                            }
                        }

                        configuration.playing = newConfiguration.playing;

                        return configuration;
                    };
                })
            .subscribe(this._configurationOperation$);

        this._stopSubscription = this._configuration$
            .flatMapLatest(
                (configuration: ISequenceConfiguration): rx.Observable<[Node, EdgeDirection]> => {
                    let node$: rx.Observable<Node> = configuration.playing ?
                        this._navigator.stateService.currentNode$ :
                        rx.Observable.empty<Node>();

                    let edgeDirection$: rx.Observable<EdgeDirection> = rx.Observable
                        .just(configuration.direction);

                    return rx.Observable.combineLatest(
                        node$,
                        edgeDirection$,
                        (n: Node, e: EdgeDirection): [Node, EdgeDirection] => {
                            return [n, e];
                        });
                })
            .map<boolean>(
                (ne: [Node, EdgeDirection]): boolean => {
                    let node: Node = ne[0];
                    let direction: EdgeDirection = ne[1];

                    for (let edge of node.edges) {
                        if (edge.data.direction === direction) {
                            return true;
                        }
                    }

                    return false;
                })
            .filter(
                (hasEdge: boolean): boolean => {
                    return !hasEdge;
                })
            .map<ISequenceConfiguration>(
                (hasEdge: boolean): ISequenceConfiguration => {
                    return { playing: false };
                })
            .subscribe(this._configurationSubject$);

        this._hoveredKeySubscription = this._sequenceDOMInteraction.mouseEnterDirection$
            .flatMapLatest<string>(
                (direction: EdgeDirection): rx.Observable<string> => {
                    return this._navigator.stateService.currentNode$
                        .map<string>(
                            (node: Node): string => {
                                for (let edge of node.edges) {
                                    if (edge.data.direction === direction) {
                                        return edge.to;
                                    }
                                }

                                return null;
                            })
                        .takeUntil(this._sequenceDOMInteraction.mouseLeaveDirection$)
                        .concat(rx.Observable.just<string>(null));
                })
            .distinctUntilChanged()
            .subscribe(this._hoveredKeySubject$);
    }

    protected _deactivate(): void {
        this._stopSubscription.dispose();
        this._renderSubscription.dispose();
        this._configurationSubscription.dispose();
        this._containerWidthSubscription.dispose();
        this._hoveredKeySubscription.dispose();

        this.stop();
    }

    private _play(): void {
        this._playingSubscription = this._navigator.stateService.currentState$
            .filter(
                (frame: IFrame): boolean => {
                    return frame.state.nodesAhead < this._nodesAhead;
                })
            .map<Node>(
                (frame: IFrame): Node => {
                    return frame.state.lastNode;
                })
            .distinctUntilChanged(
                 (lastNode: Node): string => {
                     return lastNode.key;
                 })
            .withLatestFrom(
                this._configuration$,
                (lastNode: Node, configuration: ISequenceConfiguration): [Node, EdgeDirection] => {
                    return [lastNode, configuration.direction];
                })
            .map<string>(
                (nd: [Node, EdgeDirection]): string => {
                    let direction: EdgeDirection = nd[1];

                    for (let edge of nd[0].edges) {
                        if (edge.data.direction === direction) {
                            return edge.to;
                        }
                    }

                    return null;
                })
            .filter(
                (key: string): boolean => {
                    return key != null;
                })
            .flatMapLatest<Node>(
                (key: string): rx.Observable<Node> => {
                    return this._navigator.graphService.node$(key);
                })
            .subscribe(
                (node: Node): void => {
                    this._navigator.stateService.appendNodes([node]);
                },
                (error: Error): void => {
                    this.stop();
                }
            );

        this.fire(SequenceComponent.playingchanged, true);
    }

    private _stop(): void {
        this._playingSubscription.dispose();
        this._playingSubscription = null;

        this.fire(SequenceComponent.playingchanged, false);
    }
}

ComponentService.register(SequenceComponent);
export default SequenceComponent;