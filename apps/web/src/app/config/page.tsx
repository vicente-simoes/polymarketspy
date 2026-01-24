"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR, { useSWRConfig } from "swr"

import { Sidebar } from "@/components/sidebar"
import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { fetcher } from "@/lib/fetcher"
import {
    Activity,
    AlertTriangle,
    Beaker,
    ClipboardList,
    Layers,
    Shield,
    Sliders,
    TrendingUp,
    UserCog
} from "lucide-react"

interface GlobalConfigResponse {
    guardrails: Record<string, any>
    sizing: Record<string, any>
    system?: {
        initialBankrollMicros?: number
    }
    smallTradeBuffering?: Record<string, any>
}

interface UserConfigResponse {
    guardrails: Record<string, any>
    sizing: Record<string, any>
}

interface UserOption {
    id: string
    label: string
}

interface TestConfigResult {
    total: number
    executed: number
    skipped: number
}

type GuardrailsForm = {
    maxWorseningVsTheirFillCents: string
    maxBuyCostPerShareCents: string
    maxOverMidCents: string
    maxSpreadCents: string
    minDepthMultiplier: string
    noNewOpensMinutes: string
    decisionLatencyMs: string
    jitterMsMax: string
    maxTotalExposurePct: string
    maxExposurePerMarketPct: string
    maxExposurePerUserPct: string
    dailyLossLimitPct: string
    weeklyLossLimitPct: string
    maxDrawdownLimitPct: string
}

type SizingForm = {
    copyPctNotionalPct: string
    minTradeNotionalUsd: string
    maxTradeNotionalUsd: string
    maxTradeBankrollPct: string
}

type BudgetedDynamicForm = {
    budgetedDynamicEnabled: boolean
    sizingMode: "" | "fixedRate" | "budgetedDynamic"
    budgetUsd: string
    budgetRMinPct: string
    budgetRMaxPct: string
    budgetEnforcement: "" | "hard" | "soft"
    minLeaderTradeNotionalUsd: string
}

type SmallTradeBufferingForm = {
    enabled: boolean
    notionalThresholdUsd: string
    flushMinNotionalUsd: string
    minExecNotionalUsd: string
    maxBufferMs: string
    quietFlushMs: string
    nettingMode: "sameSideOnly" | "netBuySell"
}

const guardrailsDefaults = {
    maxWorseningVsTheirFillMicros: 10_000,
    maxOverMidMicros: 15_000,
    maxSpreadMicros: 20_000,
    minDepthMultiplierBps: 12_500,
    noNewOpensWithinMinutesToClose: 30,
    decisionLatencyMs: 0,
    jitterMsMax: 0,
    maxTotalExposureBps: 7000,
    maxExposurePerMarketBps: 500,
    maxExposurePerUserBps: 2000,
    dailyLossLimitBps: 300,
    weeklyLossLimitBps: 800,
    maxDrawdownLimitBps: 1200
}

const sizingDefaults = {
    copyPctNotionalBps: 100,
    minTradeNotionalMicros: 5_000_000,
    maxTradeNotionalMicros: 250_000_000,
    maxTradeBankrollBps: 75
}

const budgetedDynamicDefaults = {
    budgetedDynamicEnabled: false,
    sizingMode: "fixedRate" as const,
    budgetUsdcMicros: 0,
    budgetRMinBps: 0,
    budgetRMaxBps: 100, // 1.00%
    budgetEnforcement: "hard" as const,
    minLeaderTradeNotionalMicros: 0
}

const systemDefaults = {
    initialBankrollMicros: 100_000_000
}

const smallTradeBufferingDefaults = {
    enabled: false,
    notionalThresholdMicros: 250_000, // $0.25
    flushMinNotionalMicros: 500_000, // $0.50
    minExecNotionalMicros: 100_000, // $0.10
    maxBufferMs: 2500,
    quietFlushMs: 600,
    nettingMode: "sameSideOnly" as const
}

const SELECTED_USER_ID_STORAGE_KEY = "config:selectedUserId"

const toFormValue = (
    value: number | undefined,
    fallback: number,
    converter: (value: number) => number,
    allowEmpty: boolean
) => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(converter(value))
    }
    if (allowEmpty) return ""
    return String(converter(fallback))
}

const guardrailsToForm = (
    config: Record<string, any>,
    allowEmpty: boolean
): GuardrailsForm => ({
    maxWorseningVsTheirFillCents: toFormValue(
        config.maxWorseningVsTheirFillMicros,
        guardrailsDefaults.maxWorseningVsTheirFillMicros,
        (value) => value / 10_000,
        allowEmpty
    ),
    maxBuyCostPerShareCents: toFormValue(
        config.maxBuyCostPerShareMicros,
        0,
        (value) => value / 10_000,
        true
    ),
    maxOverMidCents: toFormValue(
        config.maxOverMidMicros,
        guardrailsDefaults.maxOverMidMicros,
        (value) => value / 10_000,
        allowEmpty
    ),
    maxSpreadCents: toFormValue(
        config.maxSpreadMicros,
        guardrailsDefaults.maxSpreadMicros,
        (value) => value / 10_000,
        allowEmpty
    ),
    minDepthMultiplier: toFormValue(
        config.minDepthMultiplierBps,
        guardrailsDefaults.minDepthMultiplierBps,
        (value) => value / 10_000,
        allowEmpty
    ),
    noNewOpensMinutes: toFormValue(
        config.noNewOpensWithinMinutesToClose,
        guardrailsDefaults.noNewOpensWithinMinutesToClose,
        (value) => value,
        allowEmpty
    ),
    decisionLatencyMs: toFormValue(
        config.decisionLatencyMs,
        guardrailsDefaults.decisionLatencyMs,
        (value) => value,
        allowEmpty
    ),
    jitterMsMax: toFormValue(
        config.jitterMsMax,
        guardrailsDefaults.jitterMsMax,
        (value) => value,
        allowEmpty
    ),
    maxTotalExposurePct: toFormValue(
        config.maxTotalExposureBps,
        guardrailsDefaults.maxTotalExposureBps,
        (value) => value / 100,
        allowEmpty
    ),
    maxExposurePerMarketPct: toFormValue(
        config.maxExposurePerMarketBps,
        guardrailsDefaults.maxExposurePerMarketBps,
        (value) => value / 100,
        allowEmpty
    ),
    maxExposurePerUserPct: toFormValue(
        config.maxExposurePerUserBps,
        guardrailsDefaults.maxExposurePerUserBps,
        (value) => value / 100,
        allowEmpty
    ),
    dailyLossLimitPct: toFormValue(
        config.dailyLossLimitBps,
        guardrailsDefaults.dailyLossLimitBps,
        (value) => value / 100,
        allowEmpty
    ),
    weeklyLossLimitPct: toFormValue(
        config.weeklyLossLimitBps,
        guardrailsDefaults.weeklyLossLimitBps,
        (value) => value / 100,
        allowEmpty
    ),
    maxDrawdownLimitPct: toFormValue(
        config.maxDrawdownLimitBps,
        guardrailsDefaults.maxDrawdownLimitBps,
        (value) => value / 100,
        allowEmpty
    )
})

const sizingToForm = (
    config: Record<string, any>,
    allowEmpty: boolean
): SizingForm => ({
    copyPctNotionalPct: toFormValue(
        config.copyPctNotionalBps,
        sizingDefaults.copyPctNotionalBps,
        (value) => value / 100,
        allowEmpty
    ),
    minTradeNotionalUsd: toFormValue(
        config.minTradeNotionalMicros,
        sizingDefaults.minTradeNotionalMicros,
        (value) => value / 1_000_000,
        allowEmpty
    ),
    maxTradeNotionalUsd: toFormValue(
        config.maxTradeNotionalMicros,
        sizingDefaults.maxTradeNotionalMicros,
        (value) => value / 1_000_000,
        allowEmpty
    ),
    maxTradeBankrollPct: toFormValue(
        config.maxTradeBankrollBps,
        sizingDefaults.maxTradeBankrollBps,
        (value) => value / 100,
        allowEmpty
    )
})

const smallTradeBufferingToForm = (config: Record<string, any>): SmallTradeBufferingForm => ({
    enabled: typeof config.enabled === "boolean" ? config.enabled : smallTradeBufferingDefaults.enabled,
    notionalThresholdUsd: toFormValue(
        config.notionalThresholdMicros,
        smallTradeBufferingDefaults.notionalThresholdMicros,
        (value) => value / 1_000_000,
        false
    ),
    flushMinNotionalUsd: toFormValue(
        config.flushMinNotionalMicros,
        smallTradeBufferingDefaults.flushMinNotionalMicros,
        (value) => value / 1_000_000,
        false
    ),
    minExecNotionalUsd: toFormValue(
        config.minExecNotionalMicros,
        smallTradeBufferingDefaults.minExecNotionalMicros,
        (value) => value / 1_000_000,
        false
    ),
    maxBufferMs: toFormValue(
        config.maxBufferMs,
        smallTradeBufferingDefaults.maxBufferMs,
        (value) => value,
        false
    ),
    quietFlushMs: toFormValue(
        config.quietFlushMs,
        smallTradeBufferingDefaults.quietFlushMs,
        (value) => value,
        false
    ),
    nettingMode: config.nettingMode === "netBuySell" ? "netBuySell" : "sameSideOnly"
})

const budgetedDynamicToForm = (
    config: Record<string, any>,
    allowEmpty: boolean
): BudgetedDynamicForm => ({
    budgetedDynamicEnabled:
        typeof config.budgetedDynamicEnabled === "boolean"
            ? config.budgetedDynamicEnabled
            : budgetedDynamicDefaults.budgetedDynamicEnabled,
    sizingMode: allowEmpty
        ? (config.sizingMode === "fixedRate" || config.sizingMode === "budgetedDynamic"
            ? config.sizingMode
            : "")
        : (config.sizingMode === "budgetedDynamic"
            ? "budgetedDynamic"
            : "fixedRate"),
    budgetUsd: toFormValue(
        config.budgetUsdcMicros,
        budgetedDynamicDefaults.budgetUsdcMicros,
        (value) => value / 1_000_000,
        allowEmpty
    ),
    budgetRMinPct: toFormValue(
        config.budgetRMinBps,
        budgetedDynamicDefaults.budgetRMinBps,
        (value) => value / 100,
        allowEmpty
    ),
    budgetRMaxPct: toFormValue(
        config.budgetRMaxBps,
        budgetedDynamicDefaults.budgetRMaxBps,
        (value) => value / 100,
        allowEmpty
    ),
    budgetEnforcement: allowEmpty
        ? (config.budgetEnforcement === "hard" || config.budgetEnforcement === "soft"
            ? config.budgetEnforcement
            : "")
        : (config.budgetEnforcement === "soft"
            ? "soft"
            : "hard"),
    minLeaderTradeNotionalUsd: toFormValue(
        config.minLeaderTradeNotionalMicros,
        budgetedDynamicDefaults.minLeaderTradeNotionalMicros,
        (value) => value / 1_000_000,
        allowEmpty
    )
})

const parseNumber = (value: string, label: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid ${label}`)
    }
    return parsed
}

const buildGuardrailsPayload = (form: GuardrailsForm, allowEmpty: boolean) => {
    const payload: Record<string, number> = {}

    const add = (
        key: keyof typeof guardrailsDefaults,
        value: string,
        converter: (value: number) => number
    ) => {
        if (allowEmpty && value.trim() === "") return
        const parsed = parseNumber(value, key)
        payload[key] = converter(parsed)
    }

    add("maxWorseningVsTheirFillMicros", form.maxWorseningVsTheirFillCents, (value) =>
        Math.round(value * 10_000)
    )

    if (form.maxBuyCostPerShareCents.trim() !== "") {
        const parsed = parseNumber(form.maxBuyCostPerShareCents, "maxBuyCostPerShareCents")
        if (parsed < 0 || parsed > 100) {
            throw new Error("Invalid maxBuyCostPerShareCents")
        }
        payload.maxBuyCostPerShareMicros = Math.round(parsed * 10_000)
    }

    add("maxOverMidMicros", form.maxOverMidCents, (value) => Math.round(value * 10_000))
    add("maxSpreadMicros", form.maxSpreadCents, (value) => Math.round(value * 10_000))
    add("minDepthMultiplierBps", form.minDepthMultiplier, (value) =>
        Math.round(value * 10_000)
    )
    add(
        "noNewOpensWithinMinutesToClose",
        form.noNewOpensMinutes,
        (value) => Math.round(value)
    )
    add("decisionLatencyMs", form.decisionLatencyMs, (value) => Math.round(value))
    add("jitterMsMax", form.jitterMsMax, (value) => Math.round(value))
    add("maxTotalExposureBps", form.maxTotalExposurePct, (value) => Math.round(value * 100))
    add(
        "maxExposurePerMarketBps",
        form.maxExposurePerMarketPct,
        (value) => Math.round(value * 100)
    )
    add(
        "maxExposurePerUserBps",
        form.maxExposurePerUserPct,
        (value) => Math.round(value * 100)
    )
    add("dailyLossLimitBps", form.dailyLossLimitPct, (value) => Math.round(value * 100))
    add("weeklyLossLimitBps", form.weeklyLossLimitPct, (value) => Math.round(value * 100))
    add("maxDrawdownLimitBps", form.maxDrawdownLimitPct, (value) => Math.round(value * 100))

    return payload
}

const buildSizingPayload = (form: SizingForm, allowEmpty: boolean) => {
    const payload: Record<string, number> = {}

    const add = (
        key: keyof typeof sizingDefaults,
        value: string,
        converter: (value: number) => number
    ) => {
        if (allowEmpty && value.trim() === "") return
        const parsed = parseNumber(value, key)
        payload[key] = converter(parsed)
    }

    add("copyPctNotionalBps", form.copyPctNotionalPct, (value) => Math.round(value * 100))
    add("minTradeNotionalMicros", form.minTradeNotionalUsd, (value) =>
        Math.round(value * 1_000_000)
    )
    add("maxTradeNotionalMicros", form.maxTradeNotionalUsd, (value) =>
        Math.round(value * 1_000_000)
    )
    add("maxTradeBankrollBps", form.maxTradeBankrollPct, (value) => Math.round(value * 100))

    return payload
}

const buildSmallTradeBufferingPayload = (form: SmallTradeBufferingForm) => {
    return {
        enabled: form.enabled,
        notionalThresholdMicros: Math.round(parseNumber(form.notionalThresholdUsd, "notionalThresholdUsd") * 1_000_000),
        flushMinNotionalMicros: Math.round(parseNumber(form.flushMinNotionalUsd, "flushMinNotionalUsd") * 1_000_000),
        minExecNotionalMicros: Math.round(parseNumber(form.minExecNotionalUsd, "minExecNotionalUsd") * 1_000_000),
        maxBufferMs: Math.round(parseNumber(form.maxBufferMs, "maxBufferMs")),
        quietFlushMs: Math.round(parseNumber(form.quietFlushMs, "quietFlushMs")),
        nettingMode: form.nettingMode
    }
}

const buildBudgetedDynamicPayload = (form: BudgetedDynamicForm, allowEmpty: boolean) => {
    const payload: Record<string, any> = {}

    // budgetedDynamicEnabled is always included for global (it's a required field)
    if (!allowEmpty) {
        payload.budgetedDynamicEnabled = form.budgetedDynamicEnabled
    }

    // sizingMode
    if (form.sizingMode !== "") {
        payload.sizingMode = form.sizingMode
    }

    // budgetUsd -> budgetUsdcMicros
    if (form.budgetUsd.trim() !== "") {
        const parsed = parseNumber(form.budgetUsd, "budgetUsd")
        payload.budgetUsdcMicros = Math.round(parsed * 1_000_000)
    }

    // budgetRMinPct -> budgetRMinBps
    if (form.budgetRMinPct.trim() !== "") {
        const parsed = parseNumber(form.budgetRMinPct, "budgetRMinPct")
        payload.budgetRMinBps = Math.round(parsed * 100)
    }

    // budgetRMaxPct -> budgetRMaxBps
    if (form.budgetRMaxPct.trim() !== "") {
        const parsed = parseNumber(form.budgetRMaxPct, "budgetRMaxPct")
        payload.budgetRMaxBps = Math.round(parsed * 100)
    }

    // budgetEnforcement
    if (form.budgetEnforcement !== "") {
        payload.budgetEnforcement = form.budgetEnforcement
    }

    // minLeaderTradeNotionalUsd -> minLeaderTradeNotionalMicros
    if (form.minLeaderTradeNotionalUsd.trim() !== "") {
        const parsed = parseNumber(form.minLeaderTradeNotionalUsd, "minLeaderTradeNotionalUsd")
        payload.minLeaderTradeNotionalMicros = Math.round(parsed * 1_000_000)
    }

    return payload
}

const buildMergedGlobalSizingPayload = (
    baseForm: SizingForm,
    budgetedDynamicForm: BudgetedDynamicForm
) => {
    const baseSizing = buildSizingPayload(baseForm, false)
    const budgetedDynamicSizing = buildBudgetedDynamicPayload(budgetedDynamicForm, false)
    return { ...baseSizing, ...budgetedDynamicSizing }
}

const formatPercent = (value: number) => `${value.toFixed(1)}%`

const formatBpsPercent = (value: number) => `${(value / 100).toFixed(1)}%`

function SummaryTile({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">{label}</div>
            <div className="mt-2 text-lg font-semibold text-white">{value}</div>
        </div>
    )
}

function Field({
    label,
    value,
    onChange,
    suffix,
    placeholder,
    helper,
    step = "any"
}: {
    label: string
    value: string
    onChange: (value: string) => void
    suffix?: string
    placeholder?: string
    helper?: string
    step?: string
}) {
    return (
        <div className="flex flex-col gap-2">
            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">{label}</label>
            <div className="flex items-center gap-2">
                <input
                    type="number"
                    step={step}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder={placeholder}
                    className="h-10 w-full rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white placeholder:text-[#6f6f6f] focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                />
                {suffix ? <span className="text-xs text-[#6f6f6f]">{suffix}</span> : null}
            </div>
            {helper ? <span className="text-xs text-[#6f6f6f]">{helper}</span> : null}
        </div>
    )
}

export default function ConfigPage() {
    const { toast } = useToast()
    const { mutate } = useSWRConfig()

    const {
        data: globalConfig,
        error: globalError,
        isLoading: globalLoading,
        mutate: mutateGlobal
    } = useSWR<GlobalConfigResponse>("/api/config/global", fetcher)

    const { data: users } = useSWR<UserOption[]>("/api/users", fetcher)

    const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
    const [globalGuardrailsForm, setGlobalGuardrailsForm] = useState<GuardrailsForm>(
        guardrailsToForm({}, false)
    )
    const [globalSizingForm, setGlobalSizingForm] = useState<SizingForm>(sizingToForm({}, false))
    const [userGuardrailsForm, setUserGuardrailsForm] = useState<GuardrailsForm>(
        guardrailsToForm({}, true)
    )
    const [userSizingForm, setUserSizingForm] = useState<SizingForm>(sizingToForm({}, true))
    const [globalInitialized, setGlobalInitialized] = useState(false)
    const [systemInitialized, setSystemInitialized] = useState(false)
    const [userDirty, setUserDirty] = useState(false)
    const [savingGlobal, setSavingGlobal] = useState(false)
    const [savingSystem, setSavingSystem] = useState(false)
    const [savingUser, setSavingUser] = useState(false)
    const [testResult, setTestResult] = useState<TestConfigResult | null>(null)
    const [testLoading, setTestLoading] = useState(false)
    const [initialBankrollUsd, setInitialBankrollUsd] = useState(
        String(systemDefaults.initialBankrollMicros / 1_000_000)
    )
    const [depositUsd, setDepositUsd] = useState("")
    const [depositing, setDepositing] = useState(false)
    const [bufferingForm, setBufferingForm] = useState<SmallTradeBufferingForm>(
        smallTradeBufferingToForm({})
    )
    const [bufferingInitialized, setBufferingInitialized] = useState(false)
    const [savingBuffering, setSavingBuffering] = useState(false)
    const [globalBudgetedDynamicForm, setGlobalBudgetedDynamicForm] = useState<BudgetedDynamicForm>(
        budgetedDynamicToForm({}, false)
    )
    const [userBudgetedDynamicForm, setUserBudgetedDynamicForm] = useState<BudgetedDynamicForm>(
        budgetedDynamicToForm({}, true)
    )
    const [budgetedDynamicInitialized, setBudgetedDynamicInitialized] = useState(false)
    const [savingBudgetedDynamic, setSavingBudgetedDynamic] = useState(false)

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(SELECTED_USER_ID_STORAGE_KEY)
            if (stored) {
                setSelectedUserId(stored)
            }
        } catch {
            // ignore localStorage issues (private mode, etc.)
        }
    }, [])

    useEffect(() => {
        if (!users?.length) return
        if (selectedUserId && users.some((user) => user.id === selectedUserId)) return
        setSelectedUserId(users[0].id)
    }, [users, selectedUserId])

    useEffect(() => {
        if (!selectedUserId) return
        try {
            window.localStorage.setItem(SELECTED_USER_ID_STORAGE_KEY, selectedUserId)
        } catch {
            // ignore localStorage issues (private mode, etc.)
        }
    }, [selectedUserId])

    const userConfigKey = selectedUserId ? `/api/config/user/${selectedUserId}` : null
    const { data: userConfig } = useSWR<UserConfigResponse>(userConfigKey, fetcher)

    useEffect(() => {
        if (!selectedUserId) return
        setUserDirty(false)
        setUserGuardrailsForm(guardrailsToForm({}, true))
        setUserSizingForm(sizingToForm({}, true))
        setUserBudgetedDynamicForm(budgetedDynamicToForm({}, true))
    }, [selectedUserId])

    useEffect(() => {
        if (!userConfig || userDirty) return
        setUserGuardrailsForm(guardrailsToForm(userConfig.guardrails || {}, true))
        setUserSizingForm(sizingToForm(userConfig.sizing || {}, true))
        setUserBudgetedDynamicForm(budgetedDynamicToForm(userConfig.sizing || {}, true))
    }, [userConfig, userDirty])

    useEffect(() => {
        if (globalConfig && !globalInitialized) {
            setGlobalGuardrailsForm(guardrailsToForm(globalConfig.guardrails || {}, false))
            setGlobalSizingForm(sizingToForm(globalConfig.sizing || {}, false))
            setGlobalInitialized(true)
        }
    }, [globalConfig, globalInitialized])

    useEffect(() => {
        if (globalConfig && !systemInitialized) {
            const microsRaw = globalConfig.system?.initialBankrollMicros
            const micros =
                typeof microsRaw === "number" && Number.isFinite(microsRaw)
                    ? microsRaw
                    : systemDefaults.initialBankrollMicros
            setInitialBankrollUsd(String(micros / 1_000_000))
            setSystemInitialized(true)
        }
    }, [globalConfig, systemInitialized])

    useEffect(() => {
        if (globalConfig && !bufferingInitialized) {
            setBufferingForm(smallTradeBufferingToForm(globalConfig.smallTradeBuffering || {}))
            setBufferingInitialized(true)
        }
    }, [globalConfig, bufferingInitialized])

    useEffect(() => {
        if (globalConfig && !budgetedDynamicInitialized) {
            setGlobalBudgetedDynamicForm(budgetedDynamicToForm(globalConfig.sizing || {}, false))
            setBudgetedDynamicInitialized(true)
        }
    }, [globalConfig, budgetedDynamicInitialized])

    // user form initialization handled by userDirty + userConfig effects above

    const resolvedGuardrails = useMemo(() => {
        try {
            return {
                ...guardrailsDefaults,
                ...buildGuardrailsPayload(globalGuardrailsForm, false)
            }
        } catch {
            return guardrailsDefaults
        }
    }, [globalGuardrailsForm])

    const handleSaveGlobalGuardrails = async () => {
        try {
            setSavingGlobal(true)
            const guardrails = buildGuardrailsPayload(globalGuardrailsForm, false)
            const response = await fetch("/api/config/global", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ guardrails })
            })
            if (!response.ok) {
                throw new Error("Failed to save global guardrails")
            }
            await mutateGlobal()
            toast({ title: "Saved", description: "Global guardrails updated." })
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Save failed",
                description: "Check guardrails fields for invalid values."
            })
        } finally {
            setSavingGlobal(false)
        }
    }

    const handleSaveGlobalSizing = async () => {
        try {
            setSavingGlobal(true)
            const sizing = buildMergedGlobalSizingPayload(globalSizingForm, globalBudgetedDynamicForm)
            const response = await fetch("/api/config/global", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sizing })
            })
            if (!response.ok) {
                throw new Error("Failed to save global sizing")
            }
            await mutateGlobal()
            toast({ title: "Saved", description: "Global sizing updated." })
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Save failed",
                description: "Check sizing fields for invalid values."
            })
        } finally {
            setSavingGlobal(false)
        }
    }

    const handleSaveInitialBankroll = async () => {
        try {
            setSavingSystem(true)
            const parsed = Number.parseFloat(initialBankrollUsd)
            if (!Number.isFinite(parsed) || parsed < 0) {
                throw new Error("Invalid bankroll")
            }
            const initialBankrollMicros = Math.round(parsed * 1_000_000)

            const response = await fetch("/api/config/global", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ system: { initialBankrollMicros } })
            })
            if (!response.ok) {
                throw new Error("Failed to save bankroll")
            }
            await mutateGlobal()
            toast({ title: "Saved", description: "Initial bankroll updated." })
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Save failed",
                description: "Check bankroll value for invalid numbers."
            })
        } finally {
            setSavingSystem(false)
        }
    }

    const handleDepositCash = async () => {
        try {
            setDepositing(true)
            const parsed = Number.parseFloat(depositUsd)
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error("Invalid deposit")
            }

            const response = await fetch("/api/portfolio/global/deposit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ amountUsd: parsed })
            })
            if (!response.ok) {
                throw new Error("Failed to deposit cash")
            }

            setDepositUsd("")
            mutate("/api/portfolio/global")
            toast({ title: "Deposited", description: "Cash added to global execution portfolio." })
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Deposit failed",
                description: "Check deposit value for invalid numbers."
            })
        } finally {
            setDepositing(false)
        }
    }

    const handleSaveUser = async () => {
        if (!selectedUserId) return
        try {
            setSavingUser(true)
            const guardrails = buildGuardrailsPayload(userGuardrailsForm, true)
            const baseSizing = buildSizingPayload(userSizingForm, true)
            const budgetedDynamicSizing = buildBudgetedDynamicPayload(userBudgetedDynamicForm, true)
            // Merge both sizing payloads (budgeted dynamic fields go into sizing config)
            const sizing = { ...baseSizing, ...budgetedDynamicSizing }
            const response = await fetch(`/api/config/user/${selectedUserId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ guardrails, sizing })
            })
            if (!response.ok) {
                throw new Error("Failed to save user overrides")
            }
            if (userConfigKey) {
                setUserDirty(false)
                try {
                    const refreshed = (await fetcher(userConfigKey)) as UserConfigResponse
                    mutate(userConfigKey, refreshed, false)
                } catch {
                    mutate(userConfigKey)
                }
            }
            toast({ title: "Saved", description: "User overrides updated." })
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Save failed",
                description: "Check override fields for invalid values."
            })
        } finally {
            setSavingUser(false)
        }
    }

    const handleTestConfig = async () => {
        try {
            setTestLoading(true)
            const response = await fetch("/api/config/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ scope: "GLOBAL" })
            })
            if (!response.ok) {
                throw new Error("Failed to test config")
            }
            const result = await response.json()
            setTestResult(result)
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Test failed",
                description: "Could not evaluate the last 24h of events."
            })
        } finally {
            setTestLoading(false)
        }
    }

    const handleSaveBuffering = async () => {
        try {
            setSavingBuffering(true)
            const smallTradeBuffering = buildSmallTradeBufferingPayload(bufferingForm)
            const response = await fetch("/api/config/global", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ smallTradeBuffering })
            })
            if (!response.ok) {
                throw new Error("Failed to save buffering config")
            }
            await mutateGlobal()
            toast({ title: "Saved", description: "Small trade buffering config updated." })
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Save failed",
                description: "Check buffering fields for invalid values."
            })
        } finally {
            setSavingBuffering(false)
        }
    }

    const handleSaveBudgetedDynamic = async () => {
        try {
            setSavingBudgetedDynamic(true)

            // Validate: if enabled and budgetedDynamic mode, budget must be > 0
            if (
                globalBudgetedDynamicForm.budgetedDynamicEnabled &&
                globalBudgetedDynamicForm.sizingMode === "budgetedDynamic"
            ) {
                const budgetVal = parseFloat(globalBudgetedDynamicForm.budgetUsd || "0")
                if (!Number.isFinite(budgetVal) || budgetVal <= 0) {
                    throw new Error("Budget must be > 0 when budgeted dynamic is enabled")
                }
            }

            // Validate: rMin <= rMax
            const rMinVal = parseFloat(globalBudgetedDynamicForm.budgetRMinPct || "0")
            const rMaxVal = parseFloat(globalBudgetedDynamicForm.budgetRMaxPct || "0")
            if (Number.isFinite(rMinVal) && Number.isFinite(rMaxVal) && rMinVal > rMaxVal) {
                throw new Error("r_min must be <= r_max")
            }

            const budgetedDynamicPayload = buildMergedGlobalSizingPayload(globalSizingForm, globalBudgetedDynamicForm)
            const response = await fetch("/api/config/global", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sizing: budgetedDynamicPayload })
            })
            if (!response.ok) {
                throw new Error("Failed to save budgeted dynamic config")
            }
            await mutateGlobal()
            toast({ title: "Saved", description: "Budgeted dynamic sizing config updated." })
        } catch (error: any) {
            toast({
                variant: "destructive",
                title: "Save failed",
                description: error?.message || "Check budgeted dynamic fields for invalid values."
            })
        } finally {
            setSavingBudgetedDynamic(false)
        }
    }

    return (
        <div className="relative w-full bg-black text-white overflow-hidden min-h-dvh md:h-screen">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex flex-col md:flex-row gap-4 md:gap-6 p-4 md:p-6 pt-20 md:pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <p className="text-sm text-[#6f6f6f]">Configuration</p>
                                <h1 className="text-2xl md:text-3xl font-bold text-white">Guardrails & Sizing</h1>
                            </div>
                            <Button
                                onClick={handleTestConfig}
                                disabled={testLoading}
                                className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                            >
                                <Beaker className="mr-2 h-4 w-4" />
                                {testLoading ? "Testing..." : "Test Config (24h)"}
                            </Button>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-6">
                            <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6 xl:row-span-2">
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                            <Shield className="h-4 w-4 text-[#86efac]" />
                                            Global Guardrails & Risk Limits
                                        </div>
                                        <div className="text-xs text-[#6f6f6f]">
                                            Price protection, liquidity, timing, and risk caps.
                                        </div>
                                    </div>
                                    <Button
                                        onClick={handleSaveGlobalGuardrails}
                                        disabled={savingGlobal}
                                        className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                    >
                                        {savingGlobal ? "Saving..." : "Save Guardrails"}
                                    </Button>
                                </div>

                                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                    <SummaryTile
                                        label="Total Exposure Cap"
                                        value={formatBpsPercent(resolvedGuardrails.maxTotalExposureBps)}
                                    />
                                    <SummaryTile
                                        label="Per Market Cap"
                                        value={formatBpsPercent(resolvedGuardrails.maxExposurePerMarketBps)}
                                    />
                                    <SummaryTile
                                        label="Per User Cap"
                                        value={formatBpsPercent(resolvedGuardrails.maxExposurePerUserBps)}
                                    />
                                    <SummaryTile
                                        label="Daily Loss Limit"
                                        value={formatBpsPercent(resolvedGuardrails.dailyLossLimitBps)}
                                    />
                                    <SummaryTile
                                        label="Weekly Loss Limit"
                                        value={formatBpsPercent(resolvedGuardrails.weeklyLossLimitBps)}
                                    />
                                    <SummaryTile
                                        label="Max Drawdown"
                                        value={formatBpsPercent(resolvedGuardrails.maxDrawdownLimitBps)}
                                    />
                                </div>

                                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                                    <Field
                                        label="Max Worsening vs Their Fill"
                                        value={globalGuardrailsForm.maxWorseningVsTheirFillCents}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxWorseningVsTheirFillCents: value
                                            }))
                                        }
                                        suffix="cents"
                                        helper="Default 1.0c"
                                    />
                                    <Field
                                        label="Max Buy Cost per Share"
                                        value={globalGuardrailsForm.maxBuyCostPerShareCents}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxBuyCostPerShareCents: value
                                            }))
                                        }
                                        suffix="cents"
                                        helper="Leave blank to disable (e.g. 97 or 99.8)."
                                    />
                                    <Field
                                        label="Max Over Mid"
                                        value={globalGuardrailsForm.maxOverMidCents}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxOverMidCents: value
                                            }))
                                        }
                                        suffix="cents"
                                        helper="Default 1.5c"
                                    />
                                    <Field
                                        label="Max Spread"
                                        value={globalGuardrailsForm.maxSpreadCents}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxSpreadCents: value
                                            }))
                                        }
                                        suffix="cents"
                                        helper="Default 2.0c"
                                    />
                                    <Field
                                        label="Depth Multiplier"
                                        value={globalGuardrailsForm.minDepthMultiplier}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                minDepthMultiplier: value
                                            }))
                                        }
                                        suffix="x"
                                        helper="Default 1.25x"
                                    />
                                    <Field
                                        label="No New Opens Within"
                                        value={globalGuardrailsForm.noNewOpensMinutes}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                noNewOpensMinutes: value
                                            }))
                                        }
                                        suffix="min"
                                    />
                                    <Field
                                        label="Decision Latency"
                                        value={globalGuardrailsForm.decisionLatencyMs}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                decisionLatencyMs: value
                                            }))
                                        }
                                        suffix="ms"
                                    />
                                    <Field
                                        label="Jitter Max"
                                        value={globalGuardrailsForm.jitterMsMax}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                jitterMsMax: value
                                            }))
                                        }
                                        suffix="ms"
                                    />
                                    <Field
                                        label="Max Total Exposure"
                                        value={globalGuardrailsForm.maxTotalExposurePct}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxTotalExposurePct: value
                                            }))
                                        }
                                        suffix="%"
                                    />
                                    <Field
                                        label="Max Exposure per Market"
                                        value={globalGuardrailsForm.maxExposurePerMarketPct}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxExposurePerMarketPct: value
                                            }))
                                        }
                                        suffix="%"
                                    />
                                    <Field
                                        label="Max Exposure per User"
                                        value={globalGuardrailsForm.maxExposurePerUserPct}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxExposurePerUserPct: value
                                            }))
                                        }
                                        suffix="%"
                                    />
                                    <Field
                                        label="Daily Loss Limit"
                                        value={globalGuardrailsForm.dailyLossLimitPct}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                dailyLossLimitPct: value
                                            }))
                                        }
                                        suffix="%"
                                    />
                                    <Field
                                        label="Weekly Loss Limit"
                                        value={globalGuardrailsForm.weeklyLossLimitPct}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                weeklyLossLimitPct: value
                                            }))
                                        }
                                        suffix="%"
                                    />
                                    <Field
                                        label="Max Drawdown Limit"
                                        value={globalGuardrailsForm.maxDrawdownLimitPct}
                                        onChange={(value) =>
                                            setGlobalGuardrailsForm((prev) => ({
                                                ...prev,
                                                maxDrawdownLimitPct: value
                                            }))
                                        }
                                        suffix="%"
                                    />
                                </div>
                                {globalError ? (
                                    <div className="mt-3 text-sm text-red-500">
                                        Failed to load guardrails.
                                    </div>
                                ) : null}
                            </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6 xl:col-start-2 xl:row-start-1">
                                    <div className="flex items-center justify-between gap-4">
                                        <div>
                                            <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                                <Activity className="h-4 w-4 text-[#86efac]" />
                                                Global Bankroll
                                            </div>
                                            <div className="text-xs text-[#6f6f6f]">
                                                Starting cash for the global execution portfolio.
                                            </div>
                                        </div>
                                        <Button
                                            onClick={handleSaveInitialBankroll}
                                            disabled={savingSystem}
                                            className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                        >
                                            {savingSystem ? "Saving..." : "Save Bankroll"}
                                        </Button>
                                    </div>
                                    <div className="mt-4 grid grid-cols-1 gap-4">
                                        <Field
                                            label="Initial Bankroll"
                                            value={initialBankrollUsd}
                                            onChange={setInitialBankrollUsd}
                                            suffix="USDC"
                                            helper="Used for EXEC_GLOBAL cash + equity."
                                        />
                                    </div>
                                    <div className="mt-6 border-t border-[#27272A] pt-6">
                                        <div className="flex items-center justify-between gap-4">
                                            <div>
                                                <div className="text-sm text-[#6f6f6f]">Inject cash</div>
                                                <div className="text-xs text-[#6f6f6f]">
                                                    Adds a DEPOSIT ledger entry (does not change initial bankroll).
                                                </div>
                                            </div>
                                            <Button
                                                onClick={handleDepositCash}
                                                disabled={depositing}
                                                className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                            >
                                                {depositing ? "Depositing..." : "Deposit"}
                                            </Button>
                                        </div>
                                        <div className="mt-4 grid grid-cols-1 gap-4">
                                            <Field
                                                label="Deposit amount"
                                                value={depositUsd}
                                                onChange={setDepositUsd}
                                                suffix="USDC"
                                                helper="Takes effect on the next snapshot tick (~1 minute)."
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6 xl:col-start-2 xl:row-start-2">
                                    <div className="flex items-center justify-between gap-4">
                                        <div>
                                            <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                                <Sliders className="h-4 w-4 text-[#86efac]" />
                                                Global Sizing
                                            </div>
                                            <div className="text-xs text-[#6f6f6f]">
                                                Copy percent and notional caps.
                                            </div>
                                        </div>
                                        <Button
                                            onClick={handleSaveGlobalSizing}
                                            disabled={savingGlobal}
                                            className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                        >
                                            {savingGlobal ? "Saving..." : "Save Sizing"}
                                        </Button>
                                    </div>
                                    <div className="mt-4 grid grid-cols-1 gap-4">
                                        <Field
                                            label="Copy % of Notional"
                                            value={globalSizingForm.copyPctNotionalPct}
                                            onChange={(value) =>
                                                setGlobalSizingForm((prev) => ({
                                                    ...prev,
                                                    copyPctNotionalPct: value
                                                }))
                                            }
                                            suffix="%"
                                        />
                                        <Field
                                            label="Min Trade Notional"
                                            value={globalSizingForm.minTradeNotionalUsd}
                                            onChange={(value) =>
                                                setGlobalSizingForm((prev) => ({
                                                    ...prev,
                                                    minTradeNotionalUsd: value
                                                }))
                                            }
                                            suffix="USDC"
                                        />
                                        <Field
                                            label="Max Trade Notional"
                                            value={globalSizingForm.maxTradeNotionalUsd}
                                            onChange={(value) =>
                                                setGlobalSizingForm((prev) => ({
                                                    ...prev,
                                                    maxTradeNotionalUsd: value
                                                }))
                                            }
                                            suffix="USDC"
                                        />
                                        <Field
                                            label="Max Trade % of Bankroll"
                                            value={globalSizingForm.maxTradeBankrollPct}
                                            onChange={(value) =>
                                                setGlobalSizingForm((prev) => ({
                                                    ...prev,
                                                    maxTradeBankrollPct: value
                                                }))
                                            }
                                            suffix="%"
                                        />
                                    </div>
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6 xl:col-start-1 xl:row-start-3">
                                    <div className="flex items-center justify-between gap-4">
                                        <div>
                                            <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                                <TrendingUp className="h-4 w-4 text-[#86efac]" />
                                                Budgeted Dynamic Sizing
                                            </div>
                                            <div className="text-xs text-[#6f6f6f]">
                                                Allocate per-leader budgets for dynamic copy rates.
                                            </div>
                                        </div>
                                        <Button
                                            onClick={handleSaveBudgetedDynamic}
                                            disabled={savingBudgetedDynamic}
                                            className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                        >
                                            {savingBudgetedDynamic ? "Saving..." : "Save Dynamic"}
                                        </Button>
                                    </div>
                                    <div className="mt-4">
                                        <div className="flex items-center gap-3">
                                            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Enabled (Kill Switch)
                                            </label>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setGlobalBudgetedDynamicForm((prev) => ({
                                                        ...prev,
                                                        budgetedDynamicEnabled: !prev.budgetedDynamicEnabled
                                                    }))
                                                }
                                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                                    globalBudgetedDynamicForm.budgetedDynamicEnabled ? "bg-[#86efac]" : "bg-[#27272A]"
                                                }`}
                                            >
                                                <span
                                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                                        globalBudgetedDynamicForm.budgetedDynamicEnabled ? "translate-x-6" : "translate-x-1"
                                                    }`}
                                                />
                                            </button>
                                            <span className="text-xs text-[#6f6f6f]">
                                                {globalBudgetedDynamicForm.budgetedDynamicEnabled ? "ON" : "OFF"}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="mt-4 grid grid-cols-1 gap-4">
                                        <div className="flex flex-col gap-2">
                                            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Sizing Mode
                                            </label>
                                            <select
                                                value={globalBudgetedDynamicForm.sizingMode}
                                                onChange={(event) =>
                                                    setGlobalBudgetedDynamicForm((prev) => ({
                                                        ...prev,
                                                        sizingMode: event.target.value as "fixedRate" | "budgetedDynamic"
                                                    }))
                                                }
                                                className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                            >
                                                <option value="fixedRate">Fixed Rate (current behavior)</option>
                                                <option value="budgetedDynamic">Budgeted Dynamic</option>
                                            </select>
                                            <span className="text-xs text-[#6f6f6f]">
                                                Fixed Rate uses copy %, Budgeted Dynamic uses budget / leader exposure
                                            </span>
                                        </div>
                                        <Field
                                            label="Budget per Leader"
                                            value={globalBudgetedDynamicForm.budgetUsd}
                                            onChange={(value) =>
                                                setGlobalBudgetedDynamicForm((prev) => ({
                                                    ...prev,
                                                    budgetUsd: value
                                                }))
                                            }
                                            suffix="USDC"
                                            helper="Your allocation for this leader (e.g. $40)"
                                        />
                                        <Field
                                            label="r_min (Rate Floor)"
                                            value={globalBudgetedDynamicForm.budgetRMinPct}
                                            onChange={(value) =>
                                                setGlobalBudgetedDynamicForm((prev) => ({
                                                    ...prev,
                                                    budgetRMinPct: value
                                                }))
                                            }
                                            suffix="%"
                                            helper="Minimum effective copy rate (default 0%)"
                                        />
                                        <Field
                                            label="r_max (Rate Ceiling)"
                                            value={globalBudgetedDynamicForm.budgetRMaxPct}
                                            onChange={(value) =>
                                                setGlobalBudgetedDynamicForm((prev) => ({
                                                    ...prev,
                                                    budgetRMaxPct: value
                                                }))
                                            }
                                            suffix="%"
                                            helper="Maximum effective copy rate (default 1%)"
                                        />
                                        <div className="flex flex-col gap-2">
                                            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Budget Enforcement
                                            </label>
                                            <select
                                                value={globalBudgetedDynamicForm.budgetEnforcement}
                                                onChange={(event) =>
                                                    setGlobalBudgetedDynamicForm((prev) => ({
                                                        ...prev,
                                                        budgetEnforcement: event.target.value as "hard" | "soft"
                                                    }))
                                                }
                                                className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                            >
                                                <option value="hard">Hard (caps exposure at budget)</option>
                                                <option value="soft">Soft (influences rate only)</option>
                                            </select>
                                            <span className="text-xs text-[#6f6f6f]">
                                                Hard enforcement will skip/reduce trades that exceed budget
                                            </span>
                                        </div>
                                        <Field
                                            label="Min Leader Trade"
                                            value={globalBudgetedDynamicForm.minLeaderTradeNotionalUsd}
                                            onChange={(value) =>
                                                setGlobalBudgetedDynamicForm((prev) => ({
                                                    ...prev,
                                                    minLeaderTradeNotionalUsd: value
                                                }))
                                            }
                                            suffix="USDC"
                                            helper="Skip leader trades below this size (0 = disabled)"
                                        />
                                    </div>
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6 xl:col-start-2 xl:row-start-3">
                                    <div className="flex items-center justify-between gap-4">
                                        <div>
                                            <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                                <Layers className="h-4 w-4 text-[#86efac]" />
                                                Small Trade Buffering
                                            </div>
                                            <div className="text-xs text-[#6f6f6f]">
                                                Buffer tiny trades and flush in batches.
                                            </div>
                                        </div>
                                        <Button
                                            onClick={handleSaveBuffering}
                                            disabled={savingBuffering}
                                            className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                        >
                                            {savingBuffering ? "Saving..." : "Save Buffering"}
                                        </Button>
                                    </div>
                                    <div className="mt-4">
                                        <div className="flex items-center gap-3">
                                            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Enabled
                                            </label>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setBufferingForm((prev) => ({
                                                        ...prev,
                                                        enabled: !prev.enabled
                                                    }))
                                                }
                                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                                    bufferingForm.enabled ? "bg-[#86efac]" : "bg-[#27272A]"
                                                }`}
                                            >
                                                <span
                                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                                        bufferingForm.enabled ? "translate-x-6" : "translate-x-1"
                                                    }`}
                                                />
                                            </button>
                                            <span className="text-xs text-[#6f6f6f]">
                                                {bufferingForm.enabled ? "ON" : "OFF"}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="mt-4 grid grid-cols-1 gap-4">
                                        <Field
                                            label="Small Trade Threshold"
                                            value={bufferingForm.notionalThresholdUsd}
                                            onChange={(value) =>
                                                setBufferingForm((prev) => ({
                                                    ...prev,
                                                    notionalThresholdUsd: value
                                                }))
                                            }
                                            suffix="USDC"
                                            helper="Trades below this are buffered (default $0.25)"
                                        />
                                        <Field
                                            label="Flush Min Notional"
                                            value={bufferingForm.flushMinNotionalUsd}
                                            onChange={(value) =>
                                                setBufferingForm((prev) => ({
                                                    ...prev,
                                                    flushMinNotionalUsd: value
                                                }))
                                            }
                                            suffix="USDC"
                                            helper="Min accumulated to trigger flush (default $0.50)"
                                        />
                                        <Field
                                            label="Min Exec Notional"
                                            value={bufferingForm.minExecNotionalUsd}
                                            onChange={(value) =>
                                                setBufferingForm((prev) => ({
                                                    ...prev,
                                                    minExecNotionalUsd: value
                                                }))
                                            }
                                            suffix="USDC"
                                            helper="Skip if below this on flush (default $0.10)"
                                        />
                                        <Field
                                            label="Max Buffer Time"
                                            value={bufferingForm.maxBufferMs}
                                            onChange={(value) =>
                                                setBufferingForm((prev) => ({
                                                    ...prev,
                                                    maxBufferMs: value
                                                }))
                                            }
                                            suffix="ms"
                                            helper="Hard deadline to flush bucket (default 2500ms)"
                                        />
                                        <Field
                                            label="Quiet Flush Time"
                                            value={bufferingForm.quietFlushMs}
                                            onChange={(value) =>
                                                setBufferingForm((prev) => ({
                                                    ...prev,
                                                    quietFlushMs: value
                                                }))
                                            }
                                            suffix="ms"
                                            helper="Flush if no activity for this long (default 600ms)"
                                        />
                                        <div className="flex flex-col gap-2">
                                            <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Netting Mode
                                            </label>
                                            <select
                                                value={bufferingForm.nettingMode}
                                                onChange={(event) =>
                                                    setBufferingForm((prev) => ({
                                                        ...prev,
                                                        nettingMode: event.target.value as "sameSideOnly" | "netBuySell"
                                                    }))
                                                }
                                                className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                            >
                                                <option value="sameSideOnly">Same Side Only</option>
                                                <option value="netBuySell">Net Buy/Sell</option>
                                            </select>
                                            <span className="text-xs text-[#6f6f6f]">
                                                Same Side Only recommended (simpler, safer)
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6 xl:col-span-2 xl:row-start-4">
                                    <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                        <ClipboardList className="h-4 w-4 text-[#86efac]" />
                                        Test Config (24h)
                                    </div>
                                    <div className="mt-4 grid grid-cols-3 gap-3">
                                        <SummaryTile label="Total" value={testResult ? `${testResult.total}` : "--"} />
                                        <SummaryTile
                                            label="Executed"
                                            value={testResult ? `${testResult.executed}` : "--"}
                                        />
                                        <SummaryTile
                                            label="Skipped"
                                            value={testResult ? `${testResult.skipped}` : "--"}
                                        />
                                    </div>
                                    {testResult ? (
                                        <div className="mt-3 text-xs text-[#6f6f6f]">
                                            Execution rate: {" "}
                                            {formatPercent(
                                                testResult.total > 0
                                                    ? (testResult.executed / testResult.total) * 100
                                                    : 0
                                            )}
                                        </div>
                                    ) : (
                                        <div className="mt-3 text-xs text-[#6f6f6f]">
                                            Run a test to preview last 24h execution outcomes.
                                        </div>
                                    )}
                                </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-6">
                            <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                <div className="flex flex-wrap items-center justify-between gap-4">
                                    <div>
                                        <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                            <UserCog className="h-4 w-4 text-[#86efac]" />
                                            Per-User Overrides
                                        </div>
                                        <div className="text-xs text-[#6f6f6f]">
                                            Leave blank to inherit global config.
                                        </div>
                                    </div>
                                    <Button
                                        onClick={handleSaveUser}
                                        disabled={!selectedUserId || savingUser}
                                        className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                    >
                                        {savingUser ? "Saving..." : "Save Overrides"}
                                    </Button>
                                </div>

                                <div className="mt-4 grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4">
                                    <div className="flex flex-col gap-2">
                                        <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Followed User
                                        </label>
                                        <select
                                            value={selectedUserId ?? ""}
                                            onChange={(event) => setSelectedUserId(event.target.value)}
                                            className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                        >
                                            {users?.map((user) => (
                                                <option key={user.id} value={user.id}>
                                                    {user.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                </div>

                                <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                                    <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Guardrails Override
                                        </div>
                                        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <Field
                                                label="Max Worsening vs Their Fill"
                                                value={userGuardrailsForm.maxWorseningVsTheirFillCents}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxWorseningVsTheirFillCents: value
                                                    }))
                                                }}
                                                suffix="cents"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Over Mid"
                                                value={userGuardrailsForm.maxOverMidCents}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxOverMidCents: value
                                                    }))
                                                }}
                                                suffix="cents"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Spread"
                                                value={userGuardrailsForm.maxSpreadCents}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxSpreadCents: value
                                                    }))
                                                }}
                                                suffix="cents"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Depth Multiplier"
                                                value={userGuardrailsForm.minDepthMultiplier}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        minDepthMultiplier: value
                                                    }))
                                                }}
                                                suffix="x"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="No New Opens Within"
                                                value={userGuardrailsForm.noNewOpensMinutes}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        noNewOpensMinutes: value
                                                    }))
                                                }}
                                                suffix="min"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Decision Latency"
                                                value={userGuardrailsForm.decisionLatencyMs}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        decisionLatencyMs: value
                                                    }))
                                                }}
                                                suffix="ms"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Jitter Max"
                                                value={userGuardrailsForm.jitterMsMax}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        jitterMsMax: value
                                                    }))
                                                }}
                                                suffix="ms"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Total Exposure"
                                                value={userGuardrailsForm.maxTotalExposurePct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxTotalExposurePct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Exposure per Market"
                                                value={userGuardrailsForm.maxExposurePerMarketPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxExposurePerMarketPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Exposure per User"
                                                value={userGuardrailsForm.maxExposurePerUserPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxExposurePerUserPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Daily Loss Limit"
                                                value={userGuardrailsForm.dailyLossLimitPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        dailyLossLimitPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Weekly Loss Limit"
                                                value={userGuardrailsForm.weeklyLossLimitPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        weeklyLossLimitPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Drawdown Limit"
                                                value={userGuardrailsForm.maxDrawdownLimitPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxDrawdownLimitPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                            Sizing Override
                                        </div>
                                        <div className="mt-3 grid grid-cols-1 gap-4">
                                            <Field
                                                label="Copy % of Notional"
                                                value={userSizingForm.copyPctNotionalPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        copyPctNotionalPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Min Trade Notional"
                                                value={userSizingForm.minTradeNotionalUsd}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        minTradeNotionalUsd: value
                                                    }))
                                                }}
                                                suffix="USDC"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Trade Notional"
                                                value={userSizingForm.maxTradeNotionalUsd}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        maxTradeNotionalUsd: value
                                                    }))
                                                }}
                                                suffix="USDC"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Trade % of Bankroll"
                                                value={userSizingForm.maxTradeBankrollPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        maxTradeBankrollPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-[#27272A] bg-[#111111] p-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                Budgeted Dynamic Override
                                            </div>
                                            <Button
                                                onClick={handleSaveUser}
                                                disabled={!selectedUserId || savingUser}
                                                className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                            >
                                                {savingUser ? "Saving..." : "Save Overrides"}
                                            </Button>
                                        </div>
                                        <div className="mt-3 grid grid-cols-1 gap-4">
                                            <div className="flex flex-col gap-2">
                                                <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Sizing Mode
                                                </label>
                                                <select
                                                    value={userBudgetedDynamicForm.sizingMode}
                                                    onChange={(event) => {
                                                        setUserDirty(true)
                                                        setUserBudgetedDynamicForm((prev) => ({
                                                            ...prev,
                                                            sizingMode: event.target.value as "" | "fixedRate" | "budgetedDynamic"
                                                        }))
                                                    }}
                                                    className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                                >
                                                    <option value="">Inherit</option>
                                                    <option value="fixedRate">Fixed Rate</option>
                                                    <option value="budgetedDynamic">Budgeted Dynamic</option>
                                                </select>
                                            </div>
                                            <Field
                                                label="Budget per Leader"
                                                value={userBudgetedDynamicForm.budgetUsd}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserBudgetedDynamicForm((prev) => ({
                                                        ...prev,
                                                        budgetUsd: value
                                                    }))
                                                }}
                                                suffix="USDC"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="r_min (Rate Floor)"
                                                value={userBudgetedDynamicForm.budgetRMinPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserBudgetedDynamicForm((prev) => ({
                                                        ...prev,
                                                        budgetRMinPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="r_max (Rate Ceiling)"
                                                value={userBudgetedDynamicForm.budgetRMaxPct}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserBudgetedDynamicForm((prev) => ({
                                                        ...prev,
                                                        budgetRMaxPct: value
                                                    }))
                                                }}
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <div className="flex flex-col gap-2">
                                                <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Budget Enforcement
                                                </label>
                                                <select
                                                    value={userBudgetedDynamicForm.budgetEnforcement}
                                                    onChange={(event) => {
                                                        setUserDirty(true)
                                                        setUserBudgetedDynamicForm((prev) => ({
                                                            ...prev,
                                                            budgetEnforcement: event.target.value as "" | "hard" | "soft"
                                                        }))
                                                    }}
                                                    className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                                >
                                                    <option value="">Inherit</option>
                                                    <option value="hard">Hard</option>
                                                    <option value="soft">Soft</option>
                                                </select>
                                            </div>
                                            <Field
                                                label="Min Leader Trade"
                                                value={userBudgetedDynamicForm.minLeaderTradeNotionalUsd}
                                                onChange={(value) => {
                                                    setUserDirty(true)
                                                    setUserBudgetedDynamicForm((prev) => ({
                                                        ...prev,
                                                        minLeaderTradeNotionalUsd: value
                                                    }))
                                                }}
                                                suffix="USDC"
                                                placeholder="inherit"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                                <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                                    Engine Control
                                </div>
                                <div className="mt-4 space-y-3">
                                    <Button
                                        variant="destructive"
                                        className="w-full font-semibold"
                                        onClick={async () => {
                                            await fetch("/api/control/pause", {
                                                method: "POST",
                                                headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ action: "PAUSE" })
                                            })
                                            mutate("/api/config/global")
                                        }}
                                    >
                                        Pause Copy Engine
                                    </Button>
                                    <Button
                                        className="w-full bg-[#86efac] text-black hover:bg-[#4ade80]"
                                        onClick={async () => {
                                            await fetch("/api/control/pause", {
                                                method: "POST",
                                                headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ action: "RESUME" })
                                            })
                                            mutate("/api/config/global")
                                        }}
                                    >
                                        Resume Copy Engine
                                    </Button>
                                    <div className="text-xs text-[#6f6f6f]">
                                        Copy engine status updates are reflected on the Overview page.
                                    </div>
                                </div>
                            </div>
                        </div>

                        {globalLoading ? (
                            <div className="text-[#6f6f6f]">Loading config...</div>
                        ) : null}
                    </div>
                </main>
            </div>
        </div>
    )
}
