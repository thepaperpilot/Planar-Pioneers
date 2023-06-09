import Modal from "components/Modal.vue";
import StickyVue from "components/layout/Sticky.vue";
import {
    BoardNode,
    BoardNodeLink,
    GenericBoard,
    createBoard,
    getUniqueNodeID
} from "features/boards/board";
import { jsx, setDefault } from "features/feature";
import { createResource } from "features/resources/resource";
import { createTabFamily } from "features/tabs/tabFamily";
import Formula from "game/formulas/formulas";
import { GenericFormula } from "game/formulas/types";
import { BaseLayer, GenericLayer, createLayer, layers } from "game/layers";
import {
    Modifier,
    createAdditiveModifier,
    createMultiplicativeModifier,
    createSequentialModifier
} from "game/modifiers";
import { DefaultValue, State } from "game/persistence";
import type { LayerData, Player } from "game/player";
import player from "game/player";
import settings, { registerSettingField } from "game/settings";
import Decimal, { DecimalSource, format, formatSmall, formatWhole } from "util/bignum";
import { WithRequired, camelToTitle } from "util/common";
import { render } from "util/vue";
import { ComputedRef, computed, nextTick, reactive, ref, watch } from "vue";
import { useToast } from "vue-toastification";
import {
    checkConnections,
    isEmpowered,
    isPowered,
    resourceLevelFormula,
    resourceLinesFilter,
    togglePoweredAction
} from "./boardUtils";
import { Section, createCollapsibleModifierSections, createFormulaPreview } from "./common";
import {
    AutomatorState,
    BoosterState,
    DowsingState,
    EmpowererState,
    InfluenceState,
    Influences,
    InvestmentsState,
    MineState,
    Passives,
    PortalGeneratorState,
    PortalState,
    QuarryState,
    ResourceState,
    Resources,
    UpgraderState,
    influences,
    mineLootTable,
    relics,
    resourceNames,
    tools
} from "./data";
import {
    getAutomatorHelp,
    getBoosterHelp,
    getDowsingHelp,
    getEmpowererHelp,
    getForgeHelp,
    getInvestmentsHelp,
    getMineHelp,
    getPortalHelp,
    getQuarryHelp,
    getUpgraderHelp
} from "./help";
import "./main.css";
import {
    automator,
    booster,
    brokenFactory,
    dowsing,
    empowerer,
    factory,
    influence,
    investments,
    mine,
    passive,
    portal,
    portalGenerator,
    quarry,
    resource,
    trashCan,
    upgrader
} from "./nodeTypes";
import { GenericPlane, createPlane } from "./planes";
import { globalBus } from "game/events";
import ToggleVue from "components/fields/Toggle.vue";

const toast = useToast();

const types = {
    mine,
    brokenFactory,
    factory,
    resource,
    passive,
    dowsing,
    quarry,
    empowerer,
    portalGenerator,
    portal,
    influence,
    booster,
    upgrader,
    automator,
    investments,
    trashCan
};

/**
 * @hidden
 */
export const main = createLayer("main", function (this: BaseLayer) {
    const energy = createResource<DecimalSource>(0, "energy");

    const resourceNodes: ComputedRef<Record<Resources, BoardNode>> = computed(() =>
        board.types.resource.nodes.value.reduce((acc, curr) => {
            acc[(curr.state as unknown as ResourceState).type] = curr;
            return acc;
        }, {} as Record<Resources, BoardNode>)
    );

    const toolNodes: ComputedRef<Record<Resources | Passives, BoardNode>> = computed(() => ({
        ...board.types.passive.nodes.value.reduce((acc, curr) => {
            acc[curr.state as Passives] = curr;
            return acc;
        }, {} as Record<Resources | Passives, BoardNode>),
        sand: board.types.dowsing.nodes.value[0],
        wood: board.types.quarry.nodes.value[0],
        coal: board.types.empowerer.nodes.value[0],
        iron: board.types.portalGenerator.nodes.value[0],
        gold: board.types.booster.nodes.value[0],
        platinum: board.types.upgrader.nodes.value[0],
        berylium: board.types.automator.nodes.value[0],
        ultimatum: board.types.investments.nodes.value[0]
    }));
    const numRelicsOwned = computed(
        () =>
            Object.keys(relics).filter(key => (`${key}Relic` as Passives) in toolNodes.value).length
    );

    const influenceNodes: ComputedRef<Record<Influences, BoardNode>> = computed(() => ({
        ...board.types.influence.nodes.value.reduce((acc, curr) => {
            acc[(curr.state as unknown as InfluenceState).type] = curr;
            return acc;
        }, {} as Record<Influences, BoardNode>)
    }));

    const portalNodes: ComputedRef<Record<string, BoardNode>> = computed(() => ({
        ...board.types.portal.nodes.value.reduce((acc, curr) => {
            acc[(curr.state as unknown as PortalState).id] = curr;
            return acc;
        }, {} as Record<string, BoardNode>)
    }));

    const resourceLevels = computed(() =>
        resourceNames.reduce((acc, curr) => {
            const amount =
                (resourceNodes.value[curr]?.state as unknown as ResourceState | undefined)
                    ?.amount ?? 0;
            acc[curr] = Decimal.floor(resourceLevelFormula.invert(amount));
            return acc;
        }, {} as Record<Resources, DecimalSource>)
    );

    const resourceMinedCooldown: Partial<Record<Resources, number>> = reactive({});
    const resourceQuarriedCooldown: Partial<Record<Resources, number>> = reactive({});

    nextTick(() => {
        resourceNames.forEach(resource => {
            watch(
                () => resourceLevels.value[resource],
                (level, prevLevel) => {
                    const diff = Decimal.sub(level, prevLevel);
                    if (
                        (Decimal.eq(level, 1) || Decimal.gt(diff, 1)) &&
                        Decimal.gt(diff, Decimal.div(prevLevel, 100)) &&
                        settings.active === player.id
                    ) {
                        toast.info(
                            <div>
                                <h3>
                                    {Decimal.eq(level, 1)
                                        ? `${camelToTitle(resource)} discovered`
                                        : `${camelToTitle(resource)} is now Level ${formatWhole(
                                              level
                                          )}`}
                                    !
                                </h3>
                                {Decimal.gt(diff, 1) ? (
                                    <div>Gained {formatWhole(diff)} levels</div>
                                ) : null}
                            </div>
                        );
                    }
                }
            );
        });
    });

    const numPoweredMachines: ComputedRef<number> = computed(() => {
        return (
            poweredMachines.filter(node => (node.value?.state as { powered: boolean })?.powered)
                .length +
            board.types.portal.nodes.value.filter(
                node => (node.state as { powered: boolean }).powered
            ).length
        );
    });
    const effectivePoweredMachines = computed(() => {
        let numMachines = numPoweredMachines.value;
        if (toolNodes.value.copperRelic != null) {
            numMachines--;
            if (isEmpowered("copperRelic")) {
                numMachines--;
            }
        }
        return numMachines;
    });
    const nextPowerCost = computed(() => {
        const numMachines = effectivePoweredMachines.value;
        return Decimal.lt(numMachines, 0)
            ? 0
            : Decimal.eq(numMachines, 0)
            ? 10
            : Decimal.add(numMachines, 1).pow_base(100).div(10).times(0.99);
    });

    const quarryProgressRequired = computed(() => {
        if (quarry.value == null) {
            return 0;
        }
        const resources = (quarry.value.state as unknown as QuarryState).resources;
        let progress = resources.reduce(
            (acc, curr) => Decimal.div(100, dropRates[curr].computedModifier.value).add(acc),
            Decimal.dZero
        );
        if (toolNodes.value.silverRelic != null) {
            progress = Decimal.div(progress, Decimal.add(numPoweredMachines.value, 1));
            if (isEmpowered("silverRelic")) {
                progress = Decimal.div(progress, Decimal.add(numPoweredMachines.value, 1));
            }
        }
        return progress;
    });

    const board = createBoard(board => ({
        startNodes: () => [
            { position: { x: 0, y: 0 }, type: "mine", state: { progress: 0, powered: false } },
            { position: { x: 0, y: -200 }, type: "brokenFactory" }
        ],
        types,
        style: {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            overflow: "hidden"
        },
        links() {
            const links: BoardNodeLink[] = [];
            links.push(
                ...(Object.keys(resourceMinedCooldown) as Resources[])
                    .filter(resourceLinesFilter(mine.value))
                    .map(resource => ({
                        startNode: mine.value,
                        endNode: resourceNodes.value[resource as Resources],
                        stroke: "var(--accent3)",
                        strokeWidth: 5
                    }))
            );
            if (factory.value != null && factory.value.state != null) {
                links.push({
                    startNode: factory.value,
                    endNode: resourceNodes.value[factory.value.state as Resources],
                    stroke: "var(--foreground)",
                    strokeWidth: 4
                });
            }
            if (dowsing.value != null) {
                (dowsing.value.state as unknown as DowsingState).resources.forEach(resource => {
                    links.push({
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        startNode: dowsing.value!,
                        endNode: resourceNodes.value[resource],
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        stroke: isPowered(dowsing.value!) ? "var(--accent1)" : "var(--foreground)",
                        strokeWidth: 4
                    });
                });
            }
            if (quarry.value != null) {
                (quarry.value.state as unknown as QuarryState).resources.forEach(resource => {
                    links.push({
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        startNode: quarry.value!,
                        endNode: resourceNodes.value[resource],
                        stroke:
                            resource in resourceQuarriedCooldown
                                ? "var(--accent3)"
                                : "var(--foreground)",
                        strokeWidth: 4
                    });
                });
            }
            if (empowerer.value != null) {
                (empowerer.value.state as unknown as EmpowererState).tools.forEach(tool => {
                    links.push({
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        startNode: empowerer.value!,
                        endNode: toolNodes.value[tool],
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        stroke: isPowered(empowerer.value!)
                            ? "var(--accent1)"
                            : "var(--foreground)",
                        strokeWidth: 4
                    });
                });
            }
            if (portalGenerator.value != null) {
                const state = portalGenerator.value.state as unknown as PortalGeneratorState;
                if (state.tier != null) {
                    links.push({
                        startNode: portalGenerator.value,
                        endNode: resourceNodes.value[state.tier],
                        stroke: "var(--foreground)",
                        strokeWidth: 4
                    });
                }
                state.influences.forEach(influence => {
                    links.push({
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        startNode: portalGenerator.value!,
                        endNode: influenceNodes.value[influence],
                        stroke: "var(--foreground)",
                        strokeWidth: 4
                    });
                });
                (board as GenericBoard).types.portal.nodes.value.forEach(node => {
                    const plane = layers[(node.state as unknown as PortalState).id] as GenericPlane;
                    resourceNames.filter(resourceLinesFilter(node)).forEach(resource => {
                        let color;
                        if (plane.links.value.includes(resource)) {
                            color = "var(--accent3)";
                        } else if (resource in plane.resourceMultis.value) {
                            color = "var(--accent1)";
                        } else {
                            return;
                        }
                        links.push({
                            startNode: node,
                            endNode: resourceNodes.value[resource],
                            stroke: isPowered(node) ? color : "var(--foreground)",
                            strokeWidth: 4
                        });
                    });
                    return links;
                });
            }
            if (booster.value != null) {
                (booster.value.state as unknown as BoosterState).portals
                    .filter(p => portalNodes.value[p] != null)
                    .forEach(portal => {
                        links.push({
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            startNode: booster.value!,
                            endNode: portalNodes.value[portal],
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            stroke: isPowered(booster.value!)
                                ? "var(--accent1)"
                                : "var(--foreground)",
                            strokeWidth: 4
                        });
                    });
            }
            if (upgrader.value != null) {
                (upgrader.value.state as unknown as UpgraderState).portals
                    .filter(p => portalNodes.value[p] != null)
                    .forEach(portal => {
                        links.push({
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            startNode: upgrader.value!,
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            endNode: portalNodes.value[portal],
                            stroke: "var(--foreground)",
                            strokeWidth: 4
                        });
                    });
            }
            if (automator.value != null) {
                (automator.value.state as unknown as AutomatorState).portals
                    .filter(p => portalNodes.value[p] != null)
                    .forEach(portal => {
                        links.push({
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            startNode: automator.value!,
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            endNode: portalNodes.value[portal],
                            stroke: "var(--foreground)",
                            strokeWidth: 4
                        });
                    });
            }
            if (investments.value != null) {
                (investments.value.state as unknown as InvestmentsState).portals
                    .filter(p => portalNodes.value[p] != null)
                    .forEach(portal => {
                        links.push({
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            startNode: investments.value!,
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            endNode: portalNodes.value[portal],
                            stroke: "var(--foreground)",
                            strokeWidth: 4
                        });
                    });
            }
            Object.values(influenceNodes.value).forEach(node => {
                const state = node.state as unknown as InfluenceState;
                if (state.type === "increaseResources" || state.type === "decreaseResources") {
                    (state.data as Resources[]).forEach(resource => {
                        links.push({
                            startNode: node,
                            endNode: resourceNodes.value[resource],
                            stroke: "var(--foreground)",
                            strokeWidth: 4
                        });
                    });
                }
            });
            return links;
        }
    }));

    const mine: ComputedRef<BoardNode> = computed(() => board.types.mine.nodes.value[0]);
    const factory: ComputedRef<BoardNode | undefined> = computed(
        () => board.types.factory.nodes.value[0]
    );
    const dowsing: ComputedRef<BoardNode | undefined> = computed(() => toolNodes.value.sand);
    const quarry: ComputedRef<BoardNode | undefined> = computed(() => toolNodes.value.wood);
    const empowerer: ComputedRef<BoardNode | undefined> = computed(() => toolNodes.value.coal);
    const portalGenerator: ComputedRef<BoardNode | undefined> = computed(
        () => toolNodes.value.iron
    );
    const booster: ComputedRef<BoardNode | undefined> = computed(() => toolNodes.value.gold);
    const upgrader: ComputedRef<BoardNode | undefined> = computed(() => toolNodes.value.platinum);
    const automator: ComputedRef<BoardNode | undefined> = computed(() => toolNodes.value.berylium);
    const investments: ComputedRef<BoardNode | undefined> = computed(
        () => toolNodes.value.ultimatum
    );
    const poweredMachines = [
        mine,
        dowsing,
        quarry,
        empowerer,
        booster,
        upgrader,
        automator,
        investments
    ];

    function grantResource(type: Resources, amount: DecimalSource) {
        let node = resourceNodes.value[type];
        amount = Decimal.times(amount, resourceGain[type].computedModifier.value);
        if (node == null) {
            node = {
                id: getUniqueNodeID(board),
                position: { ...mine.value.position },
                type: "resource",
                state: { type, amount }
            };
            board.placeInAvailableSpace(node);
            board.nodes.value.push(node);
        } else {
            const state = node.state as unknown as ResourceState;
            node.state = {
                ...state,
                amount: Decimal.add(state.amount, amount)
            } as unknown as State;
        }
    }

    // Amount of completions that could give you the exact average of each item without any partials
    const sumMineWeights = computed(() =>
        (Object.keys(mineLootTable) as Resources[]).reduce(
            (a, b) => a + new Decimal(dropRates[b].computedModifier.value).toNumber(),
            0
        )
    );

    const planarMultis = computed(() => {
        const multis: Partial<Record<Resources | "energy", DecimalSource>> = {};
        board.types.portal.nodes.value.forEach(n => {
            if (!isPowered(n)) {
                return;
            }
            const plane = layers[(n.state as unknown as PortalState).id] as GenericPlane;
            const planeMultis = plane.resourceMultis.value;
            (Object.keys(planeMultis) as (Resources | "energy")[]).forEach(type => {
                if (multis[type] != null) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    multis[type] = Decimal.times(multis[type]!, planeMultis[type]!);
                } else {
                    multis[type] = planeMultis[type];
                }
            });
        });
        return multis;
    });

    const totalResourceLevels = createSequentialModifier(() =>
        resourceNames.map(resource =>
            createAdditiveModifier(() => ({
                description: () => camelToTitle(resource),
                addend: () => resourceLevels.value[resource],
                enabled: () => Decimal.gt(resourceLevels.value[resource], 0)
            }))
        )
    );
    const computedTotalResourceLevels = computed(() => totalResourceLevels.apply(0));
    const energyModifier = createSequentialModifier(() => [
        createAdditiveModifier(() => ({
            addend: computedTotalResourceLevels,
            description: "Resource Levels"
        })),
        createMultiplicativeModifier(() => ({
            multiplier: () =>
                Decimal.pow(
                    computedmaterialLevelEffectModifier.value,
                    computedTotalResourceLevels.value
                ),
            description: () =>
                `${formatSmall(computedmaterialLevelEffectModifier.value, 3)}x per Resource Level`
        })),
        createMultiplicativeModifier(() => ({
            multiplier: () => (isEmpowered("stone") ? 4 : 2),
            description: () => (isEmpowered("stone") ? "Empowered " : "") + tools.stone.name,
            enabled: () => toolNodes.value.stone != null
        })),
        createMultiplicativeModifier(() => ({
            multiplier: () => planarMultis.value.energy ?? 1,
            description: "Planar Treasures",
            enabled: () => Decimal.neq(planarMultis.value.energy ?? 1, 1)
        })),
        createAdditiveModifier(() => ({
            addend: () => Decimal.pow(100, effectivePoweredMachines.value).div(10).neg(),
            description: "Powered Machines (100^n/10 energy/s)",
            enabled: () => Decimal.gt(effectivePoweredMachines.value, 0)
        }))
    ]);
    const computedEnergyModifier = computed(() => energyModifier.apply(0));

    const bonusConnectionsModifier = createSequentialModifier(() => [
        createAdditiveModifier(() => ({
            addend: () => (isEmpowered("unobtainium") ? 2 : 1),
            description: () =>
                (isEmpowered("unobtainium") ? "Empowered " : "") + tools.unobtainium.name,
            enabled: () => toolNodes.value.unobtainium != null
        }))
    ]);
    const computedBonusConnectionsModifier = computed(() => bonusConnectionsModifier.apply(0));

    const miningSpeedModifier = createSequentialModifier(() => [
        createMultiplicativeModifier(() => ({
            multiplier: () => (isEmpowered("dirt") ? 4 : 2),
            description: () => (isEmpowered("dirt") ? "Empowered " : "") + tools.dirt.name,
            enabled: () => toolNodes.value.dirt != null
        })),
        createMultiplicativeModifier(() => ({
            multiplier: () => Decimal.pow(numRelicsOwned.value, isEmpowered("woodRelic") ? 2 : 1),
            description: () => (isEmpowered("woodRelic") ? "Empowered " : "") + relics.wood,
            enabled: () => toolNodes.value.woodRelic != null
        }))
    ]);
    const computedMiningSpeedModifier = computed(() => miningSpeedModifier.apply(1));

    const materialGainModifier = createSequentialModifier(() => [
        createMultiplicativeModifier(() => ({
            multiplier: () => (isEmpowered("gravel") ? 4 : 2),
            description: () => (isEmpowered("gravel") ? "Empowered " : "") + tools.gravel.name,
            enabled: () => toolNodes.value.gravel != null
        }))
    ]);
    const computedMaterialGainModifier = computed(() => materialGainModifier.apply(1));

    const materialLevelEffectModifier = createSequentialModifier(() => [
        createAdditiveModifier(() => ({
            addend: () => (isEmpowered("copper") ? 0.004 : 0.002),
            description: () => (isEmpowered("copper") ? "Empowered " : "") + tools.copper.name,
            enabled: () => toolNodes.value.copper != null
        }))
    ]);
    const computedmaterialLevelEffectModifier = computed(() =>
        materialLevelEffectModifier.apply(1.01)
    );

    const dropRates = (Object.keys(mineLootTable) as Resources[]).reduce((acc, resource) => {
        const modifier = createSequentialModifier(() => [
            createMultiplicativeModifier(() => ({
                multiplier: 2,
                description: "Dowsing",
                enabled: () =>
                    dowsing.value != null &&
                    isPowered(dowsing.value) &&
                    (dowsing.value.state as unknown as DowsingState).resources.includes(resource)
            }))
        ]);
        const computedModifier = computed(() => modifier.apply(mineLootTable[resource]));
        const section = {
            title: `${camelToTitle(resource)} Drop Rate`,
            modifier,
            base: mineLootTable[resource]
        };
        acc[resource] = { modifier, computedModifier, section };
        return acc;
    }, {} as Record<Resources, { modifier: WithRequired<Modifier, "invert" | "description">; computedModifier: ComputedRef<DecimalSource>; section: Section }>);

    const resourceGain = (Object.keys(mineLootTable) as Resources[]).reduce((acc, resource) => {
        const modifier = createSequentialModifier(() => [
            createMultiplicativeModifier(() => ({
                multiplier: () => planarMultis.value[resource] ?? 1,
                description: "Planar Treasures",
                enabled: () => Decimal.neq(planarMultis.value[resource] ?? 1, 1)
            }))
        ]);
        const computedModifier = computed(() => modifier.apply(1));
        const section = {
            title: `${camelToTitle(resource)} Gain`,
            modifier
        };
        acc[resource] = { modifier, computedModifier, section };
        return acc;
    }, {} as Record<Resources, { modifier: WithRequired<Modifier, "invert" | "description">; computedModifier: ComputedRef<DecimalSource>; section: Section }>);

    const basePortalCost = computed(() => {
        const n = resourceNames.indexOf(
            (portalGenerator.value?.state as unknown as PortalGeneratorState | undefined)?.tier ??
                "dirt"
        );
        return Decimal.add(n, 1).times(n).div(2).add(9).pow10();
    });
    const portalCostModifier = createSequentialModifier(() => [
        ...(Object.keys(influences) as Influences[]).map(influence =>
            createMultiplicativeModifier(() => ({
                multiplier: influences[influence].cost,
                description: influences[influence].display,
                enabled: () =>
                    (
                        portalGenerator.value?.state as unknown as PortalGeneratorState | undefined
                    )?.influences.includes(influence) ?? false,
                smallerIsBetter: true
            }))
        ),
        createMultiplicativeModifier(() => ({
            multiplier: () => (isEmpowered("emeraldRelic") ? 0.05 : 0.1),
            description: () => (isEmpowered("emeraldRelic") ? "Empowered " : "") + relics.emerald,
            enabled: () => toolNodes.value.emeraldRelic != null,
            smallerIsBetter: true
        }))
    ]);
    const computedPortalCost = computed(() => portalCostModifier.apply(basePortalCost.value));

    const [energyTab, energyTabCollapsed] = createCollapsibleModifierSections(() => [
        {
            title: "Resource Levels",
            modifier: totalResourceLevels,
            base: 0
        },
        {
            title: "Energy Gain",
            modifier: energyModifier,
            base: 0,
            unit: "/s"
        },
        {
            title: "Portal Cost",
            modifier: portalCostModifier,
            base: basePortalCost,
            unit: " energy",
            baseText: () =>
                `${camelToTitle(
                    (portalGenerator.value?.state as unknown as PortalGeneratorState | undefined)
                        ?.tier ?? "dirt"
                )}-tier Base Cost`,
            visible: () => portalGenerator.value != null,
            smallerIsBetter: true
        },
        {
            title: "Bonus Connections",
            modifier: bonusConnectionsModifier,
            base: 0,
            visible: () => Decimal.gt(computedBonusConnectionsModifier.value, 0)
        }
    ]);
    const [miningTab, miningTabCollapsed] = createCollapsibleModifierSections(() => [
        {
            title: "Mining Speed",
            modifier: miningSpeedModifier,
            base: 1,
            unit: "/s",
            visible: () => toolNodes.value.dirt != null
        },
        {
            title: "Ore Dropped",
            modifier: materialGainModifier,
            base: 1,
            visible: () => toolNodes.value.gravel != null
        },
        {
            title: "Material Level Effect",
            modifier: materialLevelEffectModifier,
            base: 1.01,
            visible: () => toolNodes.value.copper != null
        }
    ]);
    const [resourcesTab, resourcesCollapsed] = createCollapsibleModifierSections(() =>
        Object.values(dropRates).map(d => d.section)
    );
    const [resourceGainTab, resourceGainCollapsed] = createCollapsibleModifierSections(() =>
        Object.values(resourceGain).map(d => d.section)
    );
    const modifierTabs = createTabFamily({
        general: () => ({
            display: "General",
            glowColor(): string {
                return modifierTabs.activeTab.value === this.tab ? "white" : "";
            },
            tab: energyTab,
            energyTabCollapsed
        }),
        mining: () => ({
            display: "Mine",
            glowColor(): string {
                return modifierTabs.activeTab.value === this.tab ? "white" : "";
            },
            visibility: () => Object.values(toolNodes.value).filter(n => n != null).length > 0,
            tab: miningTab,
            miningTabCollapsed
        }),
        resources: () => ({
            display: "Ore Rates",
            glowColor(): string {
                return modifierTabs.activeTab.value === this.tab ? "white" : "";
            },
            visibility: () => dowsing.value != null,
            tab: resourcesTab,
            resourcesCollapsed
        }),
        resourcesGain: () => ({
            display: "Ore Gain",
            glowColor(): string {
                return modifierTabs.activeTab.value === this.tab ? "white" : "";
            },
            visibility: () =>
                Object.values(resourceGain).some(r => Decimal.neq(r.computedModifier.value, 1)),
            tab: resourceGainTab,
            resourceGainCollapsed
        })
    });
    const showModifiersModal = ref(false);
    const modifiersModal = jsx(() => (
        <Modal
            modelValue={showModifiersModal.value}
            onUpdate:modelValue={(value: boolean) => (showModifiersModal.value = value)}
            v-slots={{
                header: () => <h2>Modifiers</h2>,
                body: () => render(modifierTabs)
            }}
        />
    ));

    const helpModals = {
        mine: getMineHelp(),
        factory: getForgeHelp(),
        dowsing: getDowsingHelp(),
        quarry: getQuarryHelp(),
        empowerer: getEmpowererHelp(),
        portalGenerator: getPortalHelp(),
        booster: getBoosterHelp(),
        upgrader: getUpgraderHelp(),
        automator: getAutomatorHelp(),
        investments: getInvestmentsHelp()
    };
    helpModals.mine.showModal[DefaultValue] = true;
    helpModals.mine.showModal.value = true;

    this.on("preUpdate", diff => {
        Object.keys(resourceMinedCooldown).forEach(resource => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            resourceMinedCooldown[resource as Resources]! -= diff;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            if (resourceMinedCooldown[resource as Resources]! <= 0) {
                delete resourceMinedCooldown[resource as Resources];
            }
        });
        Object.keys(resourceQuarriedCooldown).forEach(resource => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            resourceQuarriedCooldown[resource as Resources]! -= diff;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            if (resourceQuarriedCooldown[resource as Resources]! <= 0) {
                delete resourceQuarriedCooldown[resource as Resources];
            }
        });

        if (isPowered(mine.value)) {
            const progress = Decimal.add(
                (mine.value.state as unknown as MineState).progress,
                Decimal.times(computedMiningSpeedModifier.value, diff)
            );
            const completions = progress.floor();
            mine.value.state = {
                ...(mine.value.state as object),
                progress: Decimal.sub(progress, completions)
            };
            const allResourceCompletions = completions.div(sumMineWeights.value).floor();
            if (allResourceCompletions.gt(0)) {
                resourceNames.forEach(resource => {
                    grantResource(
                        resource,
                        Decimal.times(
                            new Decimal(dropRates[resource].computedModifier.value).toNumber(),
                            allResourceCompletions
                        ).times(computedMaterialGainModifier.value)
                    );
                    resourceMinedCooldown[resource] = 0.3;
                });
            }
            const remainder = Decimal.sub(completions, allResourceCompletions).toNumber();
            for (let i = 0; i < remainder; i++) {
                const random = Math.floor(Math.random() * sumMineWeights.value);
                let weight = 0;
                for (let i = 0; i < resourceNames.length; i++) {
                    const resource = resourceNames[i];
                    weight += new Decimal(dropRates[resource].computedModifier.value).toNumber();
                    if (random < weight) {
                        grantResource(resource, computedMaterialGainModifier.value);
                        resourceMinedCooldown[resource] = 0.3;
                        break;
                    }
                }
            }
        }

        if (quarry.value != null && isPowered(quarry.value)) {
            const { progress, resources } = quarry.value.state as unknown as QuarryState;
            if (resources.length > 0) {
                let newProgress = Decimal.add(progress, diff);
                const completions = Decimal.div(progress, quarryProgressRequired.value).floor();
                newProgress = Decimal.sub(
                    newProgress,
                    Decimal.times(completions, quarryProgressRequired.value)
                );
                quarry.value.state = { ...(quarry.value.state as object), progress: newProgress };
                if (Decimal.gt(completions, 0)) {
                    resources.forEach(resource => {
                        grantResource(resource, completions);
                        resourceQuarriedCooldown[resource] = 0.3;
                    });
                }
            }
        }

        energy.value = Decimal.add(energy.value, Decimal.times(computedEnergyModifier.value, diff));

        if (Decimal.lt(energy.value, 0)) {
            // Uh oh, time to de-power machines!
            energy.value = 0;
            poweredMachines
                .map(m => m.value)
                .filter(machine => machine != null)
                .forEach(machine => {
                    (machine?.state as { powered: boolean }).powered = false;
                });
            Object.values(portalNodes.value).forEach(portal => {
                (portal.state as { powered: boolean }).powered = false;
            });
            mine.value.state = { ...(mine.value.state as object), powered: false };
            toast.warning(
                <div>
                    <h3>Ran out of energy!</h3>
                    <div>All machines have been turned off.</div>
                </div>
            );
        }
    });

    const energyChange = computed(() => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (board.selectedAction.value === board.types.brokenFactory.actions![0]) {
            return -100;
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (board.selectedAction.value === board.types.factory.actions![1]) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            return Decimal.neg(tools[board.selectedNode.value!.state as Resources].cost);
        }
        if (board.selectedAction.value?.id === "moreConnections") {
            return Decimal.neg(
                (
                    board.selectedAction.value as unknown as { formula: GenericFormula }
                ).formula.evaluate(
                    (board.selectedNode.value?.state as unknown as { maxConnections: number })
                        .maxConnections
                )
            );
        }
        return 0;
    });
    const energyPreview = createFormulaPreview(
        Formula.variable(0).add(energy),
        () => Decimal.neq(energyChange.value, 0),
        energyChange
    );

    const energyProductionChange = computed(() => {
        if (board.selectedAction.value === togglePoweredAction) {
            return (board.selectedNode.value?.state as { powered: boolean }).powered
                ? Decimal.eq(numPoweredMachines.value, 1)
                    ? 10
                    : Decimal.pow(100, numPoweredMachines.value).div(10).times(0.99)
                : Decimal.neg(nextPowerCost.value);
        }
        return 0;
    });
    const energyProductionPreview = createFormulaPreview(
        Formula.variable(0).add(computedEnergyModifier),
        () => Decimal.neq(energyProductionChange.value, 0),
        energyProductionChange
    );

    const activePortals = computed(() => board.types.portal.nodes.value.filter(n => isPowered(n)));
    const sortedPortalTabs = computed(() =>
        activePortals.value
            .sort((a, b) => {
                const aMinimized = layers[(a.state as unknown as PortalState).id]?.minimized.value
                    ? 1
                    : 0;
                const bMinimized = layers[(b.state as unknown as PortalState).id]?.minimized.value
                    ? 1
                    : 0;
                return aMinimized - bMinimized;
            })
            .map(node => (node.state as unknown as PortalState).id)
    );

    watch(sortedPortalTabs, portalTabs => {
        nextTick(() => {
            player.tabs = ["main", ...portalTabs];
        });
    });

    watch(computedBonusConnectionsModifier, (curr, prev) => {
        if (Decimal.lt(curr, prev)) {
            checkConnections(curr, dowsing, "resources");
            checkConnections(curr, quarry, "resources");
            checkConnections(curr, empowerer, "tools");
            checkConnections(curr, booster, "portals");
            checkConnections(curr, upgrader, "portals");
            checkConnections(curr, automator, "portals");
            checkConnections(curr, investments, "portals");
        }
    });

    return {
        name: "World",
        board,
        energy,
        modifierTabs,
        resourceNodes,
        toolNodes,
        influenceNodes,
        portalNodes,
        grantResource,
        activePortals,
        nextPowerCost,
        computedBonusConnectionsModifier,
        quarryProgressRequired,
        dropRates,
        dowsing,
        empowerer,
        booster,
        upgrader,
        automator,
        investments,
        resourceLevels,
        planarMultis,
        computedPortalCost,
        helpModals,
        display: jsx(() => (
            <>
                <StickyVue class="nav-container">
                    <span class="nav-segment">
                        <h2 style="color: white; text-shadow: 0px 0px 10px white;">
                            {render(energyPreview)}
                        </h2>{" "}
                        energy
                    </span>
                    <span class="nav-segment">
                        (
                        <h3 style="color: white; text-shadow: 0px 0px 10px white;">
                            {Decimal.gt(computedEnergyModifier.value, 0) ? "+" : ""}
                            {render(energyProductionPreview)}
                        </h3>
                        /s)
                    </span>
                    {Decimal.gt(numPoweredMachines.value, 0) ? (
                        <span class="nav-segment">
                            <h3 style="color: var(--accent1); text-shadow: 0px 0px 10px var(--accent1);">
                                {formatWhole(numPoweredMachines.value)}
                            </h3>{" "}
                            {Decimal.eq(numPoweredMachines.value, 1) ? "machine" : "machines"}{" "}
                            powered
                        </span>
                    ) : null}
                    <span class="nav-segment">
                        <button
                            class="button"
                            style="display: inline"
                            onClick={() => (showModifiersModal.value = true)}
                        >
                            modifiers
                        </button>
                    </span>
                    {player.devSpeed === 0 ? (
                        <span class="nav-segment">Game Paused</span>
                    ) : player.devSpeed != null && player.devSpeed !== 1 ? (
                        <span class="nav-segment">Dev Speed: {format(player.devSpeed)}x</span>
                    ) : null}
                </StickyVue>
                {render(board)}
                {render(modifiersModal)}
                {Object.values(helpModals).map(({ modal }) => modal())}
            </>
        ))
    };
});

declare module "game/settings" {
    interface Settings {
        lineVisibility: boolean;
    }
}

globalBus.on("loadSettings", settings => {
    setDefault(settings, "lineVisibility", true);
});

registerSettingField(
    jsx(() => (
        <ToggleVue
            title={jsx(() => (
                <span class="option-title">
                    Always show lines to resource nodes
                    <desc>
                        Otherwise, will only be visible when either end of the line is selected.
                    </desc>
                </span>
            ))}
            modelValue={settings.lineVisibility}
            onUpdate:modelValue={value => (settings.lineVisibility = value)}
        />
    ))
);

/**
 * Given a player save data object being loaded, return a list of layers that should currently be enabled.
 * If your project does not use dynamic layers, this should just return all layers.
 */
export const getInitialLayers = (
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    player: Partial<Player>
): Array<GenericLayer> => {
    const layers: GenericLayer[] = [main];
    (player.layers?.main as LayerData<typeof main>)?.board?.state?.nodes
        ?.filter(node => node?.type === "portal")
        .map(node => (node?.state as PortalState | undefined)?.id ?? "")
        .forEach(id => {
            const layer = player.layers?.[id] as LayerData<GenericPlane>;
            layers.push(
                createPlane(
                    id,
                    layer.tier ?? "dirt",
                    layer.seed ?? Math.floor(Math.random() * 4294967296),
                    (layer.influences ?? []) as unknown as InfluenceState[]
                )
            );
        });
    return layers;
};

/**
 * A computed ref whose value is true whenever the game is over.
 */
export const hasWon = ref(false);

/**
 * Given a player save data object being loaded with a different version, update the save data object to match the structure of the current version.
 * @param oldVersion The version of the save being loaded in
 * @param player The save data being loaded in
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
export function fixOldSave(
    oldVersion: string | undefined,
    player: Partial<Player>
    // eslint-disable-next-line @typescript-eslint/no-empty-function
): void {}
/* eslint-enable @typescript-eslint/no-unused-vars */
