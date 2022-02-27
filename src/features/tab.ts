import TabComponent from "@/components/features/Tab.vue";
import { Computable, GetComputableType } from "@/util/computed";
import { createLazyProxy } from "@/util/proxies";
import {
    CoercableComponent,
    Component,
    GatherProps,
    getUniqueID,
    Replace,
    StyleValue
} from "./feature";

export const TabType = Symbol("Tab");

export interface TabOptions {
    classes?: Computable<Record<string, boolean>>;
    style?: Computable<StyleValue>;
    display: Computable<CoercableComponent>;
}

interface BaseTab {
    id: string;
    type: typeof TabType;
    [Component]: typeof TabComponent;
    [GatherProps]: () => Record<string, unknown>;
}

export type Tab<T extends TabOptions> = Replace<
    T & BaseTab,
    {
        classes: GetComputableType<T["classes"]>;
        style: GetComputableType<T["style"]>;
        display: GetComputableType<T["display"]>;
    }
>;

export type GenericTab = Tab<TabOptions>;

export function createTab<T extends TabOptions>(optionsFunc: () => T & ThisType<Tab<T>>): Tab<T> {
    return createLazyProxy(() => {
        const tab: T & Partial<BaseTab> = optionsFunc();
        tab.id = getUniqueID("tab-");
        tab.type = TabType;
        tab[Component] = TabComponent;

        tab[GatherProps] = function (this: GenericTab) {
            const { display } = this;
            return { display };
        };

        return tab as unknown as Tab<T>;
    });
}