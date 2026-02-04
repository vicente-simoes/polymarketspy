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
    tradingMode?: "PAPER" | "LIVE"
    guardrails: Record<string, any>
    sizing: Record<string, any>
    system?: {
        initialBankrollMicros?: number
        copyEngineEnabled?: boolean
        paperTradingEnabled?: boolean
        liveTradingEnabled?: boolean
        liveTradingReadOnlyEnabled?: boolean
    }
    smallTradeBuffering?: Record<string, any>
}

interface UserConfigResponse {
    tradingMode?: "PAPER" | "LIVE"
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

type SmallTradeBufferingForm = {
    enabled: boolean
    notionalThresholdUsd: string
    flushMinNotionalUsd: string
    minExecNotionalUsd: string
    maxBufferMs: string
    quietFlushMs: string
    nettingMode: "sameSideOnly" | "netBuySell"
}

type ConfigMode = "PAPER" | "LIVE"

type LiveGuardrailsForm = {
    liveSlippageBuyPct: string
    liveSlippageSellPct: string
    liveBookFreshnessMs: string
    liveBookWaitMs: string
    liveOrderType: "FAK" | "FOK" | "GTC"
    useFokForCorrections: boolean
    liveMaxWorseningSellCents: string
    liveMaxUnderMidSellCents: string
}

const guardrailsDefaults = {
    maxWorseningVsTheirFillMicros: 20_000,
    maxOverMidMicros: 15_000,
    maxSpreadMicros: 20_000,
    minDepthMultiplierBps: 12_500,
    noNewOpensWithinMinutesToClose: 1,
    decisionLatencyMs: 0,
    jitterMsMax: 0,
    maxTotalExposureBps: 10_000,
    maxExposurePerMarketBps: 10_000,
    maxExposurePerUserBps: 10_000,
    dailyLossLimitBps: 10_000,
    weeklyLossLimitBps: 10_000,
    maxDrawdownLimitBps: 10_000
}

const sizingDefaults = {
    copyPctNotionalBps: 1,
    minTradeNotionalMicros: 10_000,
    maxTradeNotionalMicros: 250_000_000,
    maxTradeBankrollBps: 75
}

const systemDefaults = {
    initialBankrollMicros: 100_000_000,
    copyEngineEnabled: true,
    paperTradingEnabled: true,
    liveTradingEnabled: false,
    liveTradingReadOnlyEnabled: false,
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
const SELECTED_MODE_STORAGE_KEY = "config:selectedMode"

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

const liveGuardrailsDefaults = {
    liveSlippageBpsBuy: 50, // 0.50%
    liveSlippageBpsSell: 100, // 1.00%
    liveBookFreshnessMs: 2000,
    liveBookWaitMs: 500,
    liveOrderType: "FAK" as const,
    useFokForCorrections: false,
}

const liveGuardrailsToForm = (config: Record<string, any>, allowEmpty: boolean): LiveGuardrailsForm => ({
    liveSlippageBuyPct: toFormValue(
        config.liveSlippageBpsBuy,
        liveGuardrailsDefaults.liveSlippageBpsBuy,
        (value) => value / 100,
        allowEmpty
    ),
    liveSlippageSellPct: toFormValue(
        config.liveSlippageBpsSell,
        liveGuardrailsDefaults.liveSlippageBpsSell,
        (value) => value / 100,
        allowEmpty
    ),
    liveBookFreshnessMs: toFormValue(
        config.liveBookFreshnessMs,
        liveGuardrailsDefaults.liveBookFreshnessMs,
        (value) => value,
        allowEmpty
    ),
    liveBookWaitMs: toFormValue(
        config.liveBookWaitMs,
        liveGuardrailsDefaults.liveBookWaitMs,
        (value) => value,
        allowEmpty
    ),
    liveOrderType:
        config.liveOrderType === "FOK" || config.liveOrderType === "GTC" || config.liveOrderType === "FAK"
            ? config.liveOrderType
            : liveGuardrailsDefaults.liveOrderType,
    useFokForCorrections:
        typeof config.useFokForCorrections === "boolean"
            ? config.useFokForCorrections
            : liveGuardrailsDefaults.useFokForCorrections,
    liveMaxWorseningSellCents: toFormValue(
        config.liveMaxWorseningSellMicros,
        0,
        (value) => value / 10_000,
        true
    ),
    liveMaxUnderMidSellCents: toFormValue(
        config.liveMaxUnderMidSellMicros,
        0,
        (value) => value / 10_000,
        true
    ),
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

const buildLiveGuardrailsPayload = (form: LiveGuardrailsForm, allowEmpty: boolean) => {
    const payload: Record<string, any> = {}

    const addNumber = (key: string, value: string, converter: (value: number) => number) => {
        if (allowEmpty && value.trim() === "") return
        const parsed = parseNumber(value, key)
        payload[key] = converter(parsed)
    }

    addNumber("liveSlippageBpsBuy", form.liveSlippageBuyPct, (value) => Math.round(value * 100))
    addNumber("liveSlippageBpsSell", form.liveSlippageSellPct, (value) => Math.round(value * 100))
    addNumber("liveBookFreshnessMs", form.liveBookFreshnessMs, (value) => Math.round(value))
    addNumber("liveBookWaitMs", form.liveBookWaitMs, (value) => Math.round(value))

    payload.liveOrderType = form.liveOrderType
    payload.useFokForCorrections = form.useFokForCorrections

    if (form.liveMaxWorseningSellCents.trim() !== "") {
        payload.liveMaxWorseningSellMicros = Math.round(
            parseNumber(form.liveMaxWorseningSellCents, "liveMaxWorseningSellCents") * 10_000
        )
    }
    if (form.liveMaxUnderMidSellCents.trim() !== "") {
        payload.liveMaxUnderMidSellMicros = Math.round(
            parseNumber(form.liveMaxUnderMidSellCents, "liveMaxUnderMidSellCents") * 10_000
        )
    }

    return payload
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

    const [configMode, setConfigMode] = useState<ConfigMode>("PAPER")
    const globalConfigKey = useMemo(() => `/api/config/global?mode=${configMode}`, [configMode])

    const {
        data: globalConfig,
        error: globalError,
        isLoading: globalLoading,
        mutate: mutateGlobal
    } = useSWR<GlobalConfigResponse>(globalConfigKey, fetcher)

    const { data: users } = useSWR<UserOption[]>("/api/users", fetcher)

    const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
    const [globalGuardrailsForm, setGlobalGuardrailsForm] = useState<GuardrailsForm>(
        guardrailsToForm({}, false)
    )
    const [globalLiveGuardrailsForm, setGlobalLiveGuardrailsForm] = useState<LiveGuardrailsForm>(
        liveGuardrailsToForm({}, false)
    )
    const [globalSizingForm, setGlobalSizingForm] = useState<SizingForm>(sizingToForm({}, false))
    const [userGuardrailsForm, setUserGuardrailsForm] = useState<GuardrailsForm>(
        guardrailsToForm({}, true)
    )
    const [userSizingForm, setUserSizingForm] = useState<SizingForm>(sizingToForm({}, true))
    const [globalInitialized, setGlobalInitialized] = useState(false)
    const [systemControlsInitialized, setSystemControlsInitialized] = useState(false)
    const [bankrollInitialized, setBankrollInitialized] = useState(false)
    const [userDirty, setUserDirty] = useState(false)
    const [savingGlobal, setSavingGlobal] = useState(false)
    const [savingSystem, setSavingSystem] = useState(false)
    const [savingUser, setSavingUser] = useState(false)
    const [testResult, setTestResult] = useState<TestConfigResult | null>(null)
    const [testLoading, setTestLoading] = useState(false)
    const [initialBankrollUsd, setInitialBankrollUsd] = useState(
        String(systemDefaults.initialBankrollMicros / 1_000_000)
    )
    const [copyEngineEnabled, setCopyEngineEnabled] = useState(systemDefaults.copyEngineEnabled)
    const [paperTradingEnabled, setPaperTradingEnabled] = useState(systemDefaults.paperTradingEnabled)
    const [liveTradingEnabled, setLiveTradingEnabled] = useState(systemDefaults.liveTradingEnabled)
    const [liveTradingReadOnlyEnabled, setLiveTradingReadOnlyEnabled] = useState(
        systemDefaults.liveTradingReadOnlyEnabled
    )
    const [depositUsd, setDepositUsd] = useState("")
    const [depositing, setDepositing] = useState(false)
    const [bufferingForm, setBufferingForm] = useState<SmallTradeBufferingForm>(
        smallTradeBufferingToForm({})
    )
    const [bufferingInitialized, setBufferingInitialized] = useState(false)
    const [savingBuffering, setSavingBuffering] = useState(false)

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(SELECTED_MODE_STORAGE_KEY)
            if (stored === "LIVE" || stored === "PAPER") {
                setConfigMode(stored)
            }
        } catch {
            // ignore localStorage issues (private mode, etc.)
        }
    }, [])

    useEffect(() => {
        try {
            window.localStorage.setItem(SELECTED_MODE_STORAGE_KEY, configMode)
        } catch {
            // ignore localStorage issues (private mode, etc.)
        }

        setGlobalInitialized(false)
        setSystemControlsInitialized(false)
        setBankrollInitialized(false)
        setBufferingInitialized(false)
        setGlobalGuardrailsForm(guardrailsToForm({}, false))
        setGlobalLiveGuardrailsForm(liveGuardrailsToForm({}, false))
        setGlobalSizingForm(sizingToForm({}, false))
        setBufferingForm(smallTradeBufferingToForm({}))
        setTestResult(null)

        setUserDirty(false)
        setUserGuardrailsForm(guardrailsToForm({}, true))
        setUserSizingForm(sizingToForm({}, true))
    }, [configMode])

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

    const userConfigKey = selectedUserId ? `/api/config/user/${selectedUserId}?mode=${configMode}` : null
    const { data: userConfig } = useSWR<UserConfigResponse>(userConfigKey, fetcher)

    useEffect(() => {
        if (!selectedUserId) return
        setUserDirty(false)
        setUserGuardrailsForm(guardrailsToForm({}, true))
        setUserSizingForm(sizingToForm({}, true))
    }, [selectedUserId])

    useEffect(() => {
        if (!userConfig || userDirty) return
        setUserGuardrailsForm(guardrailsToForm(userConfig.guardrails || {}, true))
        setUserSizingForm(sizingToForm(userConfig.sizing || {}, true))
    }, [userConfig, userDirty])

    useEffect(() => {
        if (globalConfig && !globalInitialized) {
            setGlobalGuardrailsForm(guardrailsToForm(globalConfig.guardrails || {}, false))
            setGlobalLiveGuardrailsForm(liveGuardrailsToForm(globalConfig.guardrails || {}, false))
            setGlobalSizingForm(sizingToForm(globalConfig.sizing || {}, false))
            setGlobalInitialized(true)
        }
    }, [globalConfig, globalInitialized])

    useEffect(() => {
        if (globalConfig && !systemControlsInitialized) {
            const system = globalConfig.system ?? {}
            setCopyEngineEnabled(
                typeof system.copyEngineEnabled === "boolean"
                    ? system.copyEngineEnabled
                    : systemDefaults.copyEngineEnabled
            )
            setPaperTradingEnabled(
                typeof system.paperTradingEnabled === "boolean"
                    ? system.paperTradingEnabled
                    : systemDefaults.paperTradingEnabled
            )
            setLiveTradingEnabled(
                typeof system.liveTradingEnabled === "boolean"
                    ? system.liveTradingEnabled
                    : systemDefaults.liveTradingEnabled
            )
            setLiveTradingReadOnlyEnabled(
                typeof system.liveTradingReadOnlyEnabled === "boolean"
                    ? system.liveTradingReadOnlyEnabled
                    : systemDefaults.liveTradingReadOnlyEnabled
            )
            setSystemControlsInitialized(true)
        }
    }, [globalConfig, systemControlsInitialized])

    useEffect(() => {
        if (configMode !== "PAPER") return
        if (globalConfig && !bankrollInitialized) {
            const microsRaw = globalConfig.system?.initialBankrollMicros
            const micros =
                typeof microsRaw === "number" && Number.isFinite(microsRaw)
                    ? microsRaw
                    : systemDefaults.initialBankrollMicros
            setInitialBankrollUsd(String(micros / 1_000_000))
            setBankrollInitialized(true)
        }
    }, [configMode, globalConfig, bankrollInitialized])

    useEffect(() => {
        if (globalConfig && !bufferingInitialized) {
            setBufferingForm(smallTradeBufferingToForm(globalConfig.smallTradeBuffering || {}))
            setBufferingInitialized(true)
        }
    }, [globalConfig, bufferingInitialized])

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
            const guardrails: Record<string, any> = {
                ...buildGuardrailsPayload(globalGuardrailsForm, false),
                ...(configMode === "LIVE"
                    ? buildLiveGuardrailsPayload(globalLiveGuardrailsForm, false)
                    : {}),
            }
            const response = await fetch(globalConfigKey, {
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
	            const sizing = buildSizingPayload(globalSizingForm, false)
	            const response = await fetch(globalConfigKey, {
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

            const response = await fetch("/api/config/global?mode=PAPER", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ system: { initialBankrollMicros } })
            })
            if (!response.ok) {
                throw new Error("Failed to save bankroll")
            }
            await mutate("/api/config/global?mode=PAPER")
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

    const handleSaveExecutionControls = async () => {
        try {
            setSavingSystem(true)

            const response = await fetch("/api/config/global?mode=PAPER", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system: {
                        copyEngineEnabled,
                        paperTradingEnabled,
                        liveTradingEnabled,
                        liveTradingReadOnlyEnabled,
                    },
                }),
            })
            if (!response.ok) {
                throw new Error("Failed to save execution controls")
            }

            await mutate("/api/config/global?mode=PAPER")
            await mutate("/api/config/global?mode=LIVE")
            mutate("/api/live/status")
            mutate("/api/overview")
            toast({ title: "Saved", description: "Execution controls updated." })
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Save failed",
                description: "Could not update execution controls.",
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
            const sizing = buildSizingPayload(userSizingForm, true)
            const response = await fetch(`/api/config/user/${selectedUserId}?mode=${configMode}`, {
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
                body: JSON.stringify({ scope: "GLOBAL", tradingMode: configMode })
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
            const response = await fetch(globalConfigKey, {
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
                            <div className="flex flex-wrap items-center gap-3">
                                <div className="flex items-center gap-2 rounded-full border border-[#27272A] bg-[#111111] p-1 text-sm text-[#cfcfcf]">
                                    {(["PAPER", "LIVE"] as const).map((mode) => (
                                        <button
                                            key={mode}
                                            className={`px-3 py-1 text-xs rounded-full ${
                                                configMode === mode
                                                    ? "bg-[#1f1f1f] text-white"
                                                    : "text-[#b0b0b0] hover:text-white"
                                            }`}
                                            onClick={() => setConfigMode(mode)}
                                        >
                                            {mode === "PAPER" ? "Paper" : "Live"}
                                        </button>
                                    ))}
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
	                        </div>

                        <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                        <Layers className="h-4 w-4 text-[#86efac]" />
                                        Execution Controls
                                    </div>
                                    <div className="text-xs text-[#6f6f6f]">
                                        Toggle what the worker enqueues and executes (paper vs live).
                                    </div>
                                </div>
                                <Button
                                    onClick={handleSaveExecutionControls}
                                    disabled={savingSystem}
                                    className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                >
                                    {savingSystem ? "Saving..." : "Save Controls"}
                                </Button>
                            </div>

                            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="flex items-center justify-between gap-4 rounded-lg border border-[#27272A] bg-[#111111] px-3 py-3">
                                    <div className="min-w-0">
                                        <div className="text-sm text-white">Copy Engine (master)</div>
                                        <div className="text-xs text-[#6f6f6f]">
                                            Master kill switch. Disables both paper and live.
                                        </div>
                                    </div>
                                    <label className="flex items-center gap-2 text-sm text-white">
                                        <input
                                            type="checkbox"
                                            checked={copyEngineEnabled}
                                            onChange={(event) => setCopyEngineEnabled(event.target.checked)}
                                        />
                                        <span>{copyEngineEnabled ? "ON" : "OFF"}</span>
                                    </label>
                                </div>

                                <div className="flex items-center justify-between gap-4 rounded-lg border border-[#27272A] bg-[#111111] px-3 py-3">
                                    <div className="min-w-0">
                                        <div className="text-sm text-white">Paper Trading</div>
                                        <div className="text-xs text-[#6f6f6f]">
                                            Enables the simulated copy execution path.
                                        </div>
                                    </div>
                                    <label className="flex items-center gap-2 text-sm text-white">
                                        <input
                                            type="checkbox"
                                            checked={paperTradingEnabled}
                                            onChange={(event) => setPaperTradingEnabled(event.target.checked)}
                                        />
                                        <span>{paperTradingEnabled ? "ON" : "OFF"}</span>
                                    </label>
                                </div>

                                <div className="flex items-center justify-between gap-4 rounded-lg border border-[#27272A] bg-[#111111] px-3 py-3">
                                    <div className="min-w-0">
                                        <div className="text-sm text-white">Live Trading (place orders)</div>
                                        <div className="text-xs text-[#6f6f6f]">
                                            Enables authenticated order placement (requires live secrets).
                                        </div>
                                    </div>
                                    <label className="flex items-center gap-2 text-sm text-white">
                                        <input
                                            type="checkbox"
                                            checked={liveTradingEnabled}
                                            onChange={(event) => setLiveTradingEnabled(event.target.checked)}
                                        />
                                        <span>{liveTradingEnabled ? "ON" : "OFF"}</span>
                                    </label>
                                </div>

                                <div className="flex items-center justify-between gap-4 rounded-lg border border-[#27272A] bg-[#111111] px-3 py-3">
                                    <div className="min-w-0">
                                        <div className="text-sm text-white">Live Read-Only (reconcile only)</div>
                                        <div className="text-xs text-[#6f6f6f]">
                                            Runs user-channel WS + reconciliation without placing orders.
                                        </div>
                                    </div>
                                    <label className="flex items-center gap-2 text-sm text-white">
                                        <input
                                            type="checkbox"
                                            checked={liveTradingReadOnlyEnabled}
                                            onChange={(event) =>
                                                setLiveTradingReadOnlyEnabled(event.target.checked)
                                            }
                                        />
                                        <span>{liveTradingReadOnlyEnabled ? "ON" : "OFF"}</span>
                                    </label>
                                </div>
                            </div>

                            <div className="mt-3 text-xs text-[#6f6f6f]">
                                Changes take effect shortly in the worker. If live is enabled, ensure the worker is
                                configured with live CLOB credentials.
                            </div>
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

                                {configMode === "LIVE" ? (
                                    <div className="mt-6 border-t border-[#27272A] pt-6">
                                        <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                            <Layers className="h-4 w-4 text-[#86efac]" />
                                            Live Execution Guardrails
                                        </div>
                                        <div className="mt-1 text-xs text-[#6f6f6f]">
                                            These settings only affect LIVE placement.
                                        </div>

                                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                                            <Field
                                                label="BUY Slippage"
                                                value={globalLiveGuardrailsForm.liveSlippageBuyPct}
                                                onChange={(value) =>
                                                    setGlobalLiveGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        liveSlippageBuyPct: value,
                                                    }))
                                                }
                                                suffix="%"
                                                helper="e.g. 0.50 = 50 bps"
                                            />
                                            <Field
                                                label="SELL Slippage"
                                                value={globalLiveGuardrailsForm.liveSlippageSellPct}
                                                onChange={(value) =>
                                                    setGlobalLiveGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        liveSlippageSellPct: value,
                                                    }))
                                                }
                                                suffix="%"
                                                helper="More tolerant sells can reduce missed exits"
                                            />
                                            <Field
                                                label="Book Freshness"
                                                value={globalLiveGuardrailsForm.liveBookFreshnessMs}
                                                onChange={(value) =>
                                                    setGlobalLiveGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        liveBookFreshnessMs: value,
                                                    }))
                                                }
                                                suffix="ms"
                                                helper="Max acceptable book age"
                                            />
                                            <Field
                                                label="Book Wait"
                                                value={globalLiveGuardrailsForm.liveBookWaitMs}
                                                onChange={(value) =>
                                                    setGlobalLiveGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        liveBookWaitMs: value,
                                                    }))
                                                }
                                                suffix="ms"
                                                helper="Wait this long for fresh WS book"
                                            />

                                            <div className="flex flex-col gap-2">
                                                <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Live Order Type
                                                </label>
                                                <select
                                                    value={globalLiveGuardrailsForm.liveOrderType}
                                                    onChange={(event) =>
                                                        setGlobalLiveGuardrailsForm((prev) => ({
                                                            ...prev,
                                                            liveOrderType: event.target.value as "FAK" | "FOK" | "GTC",
                                                        }))
                                                    }
                                                    className="h-10 rounded-lg border border-[#27272A] bg-[#111111] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#86efac]"
                                                >
                                                    <option value="FAK">FAK (default)</option>
                                                    <option value="FOK">FOK</option>
                                                    <option value="GTC">GTC (not recommended)</option>
                                                </select>
                                                <span className="text-xs text-[#6f6f6f]">
                                                    FAK is safest for copy trading.
                                                </span>
                                            </div>

                                            <div className="flex flex-col gap-2">
                                                <label className="text-xs uppercase tracking-wider text-[#6f6f6f]">
                                                    Use FOK for Corrections
                                                </label>
                                                <div className="flex items-center gap-3 rounded-lg border border-[#27272A] bg-[#111111] px-3 py-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={globalLiveGuardrailsForm.useFokForCorrections}
                                                        onChange={(event) =>
                                                            setGlobalLiveGuardrailsForm((prev) => ({
                                                                ...prev,
                                                                useFokForCorrections: event.target.checked,
                                                            }))
                                                        }
                                                    />
                                                    <span className="text-sm text-white">Enabled</span>
                                                </div>
                                                <span className="text-xs text-[#6f6f6f]">
                                                    Optional: only for reconciliation/correction flows.
                                                </span>
                                            </div>

                                            <Field
                                                label="SELL Max Worsening Override"
                                                value={globalLiveGuardrailsForm.liveMaxWorseningSellCents}
                                                onChange={(value) =>
                                                    setGlobalLiveGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        liveMaxWorseningSellCents: value,
                                                    }))
                                                }
                                                suffix="cents"
                                                helper="Blank = use base guardrail"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="SELL Max Under Mid Override"
                                                value={globalLiveGuardrailsForm.liveMaxUnderMidSellCents}
                                                onChange={(value) =>
                                                    setGlobalLiveGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        liveMaxUnderMidSellCents: value,
                                                    }))
                                                }
                                                suffix="cents"
                                                helper="Blank = use base guardrail"
                                                placeholder="inherit"
                                            />
                                        </div>
                                    </div>
                                ) : null}
                            </div>

                                {configMode === "PAPER" ? (
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
                                ) : null}

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
                                    <div className="text-sm text-[#6f6f6f] flex items-center gap-2">
                                        <TrendingUp className="h-4 w-4 text-[#86efac]" />
                                        Budgeted Dynamic Sizing (Removed)
                                    </div>
                                    <div className="mt-2 text-xs text-[#6f6f6f]">
                                        Budgeted dynamic sizing depended on shadow portfolios and has been disabled as part of the CPU fixes.
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
                                                Save Overrides
                                            </div>
                                            <Button
                                                onClick={handleSaveUser}
                                                disabled={!selectedUserId || savingUser}
                                                className="bg-[#86efac] text-black hover:bg-[#4ade80]"
                                            >
                                                {savingUser ? "Saving..." : "Save Overrides"}
                                            </Button>
                                        </div>
                                        <div className="mt-3 text-xs text-[#6f6f6f]">
                                            Budgeted dynamic sizing has been removed (shadow portfolios were deleted). Only guardrails and fixed-rate sizing overrides apply.
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
                                            mutate(globalConfigKey)
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
                                            mutate(globalConfigKey)
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
