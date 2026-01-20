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
    Shield,
    Sliders,
    UserCog
} from "lucide-react"

interface GlobalConfigResponse {
    guardrails: Record<string, any>
    sizing: Record<string, any>
    system?: {
        initialBankrollMicros?: number
    }
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

const systemDefaults = {
    initialBankrollMicros: 100_000_000
}

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
    const [userInitialized, setUserInitialized] = useState(false)
    const [savingGlobal, setSavingGlobal] = useState(false)
    const [savingSystem, setSavingSystem] = useState(false)
    const [savingUser, setSavingUser] = useState(false)
    const [testResult, setTestResult] = useState<TestConfigResult | null>(null)
    const [testLoading, setTestLoading] = useState(false)
    const [initialBankrollUsd, setInitialBankrollUsd] = useState(
        String(systemDefaults.initialBankrollMicros / 1_000_000)
    )

    useEffect(() => {
        if (!selectedUserId && users?.length) {
            setSelectedUserId(users[0].id)
        }
    }, [users, selectedUserId])

    const userConfigKey = selectedUserId ? `/api/config/user/${selectedUserId}` : null
    const { data: userConfig } = useSWR<UserConfigResponse>(userConfigKey, fetcher)

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
        if (userConfig && !userInitialized) {
            setUserGuardrailsForm(guardrailsToForm(userConfig.guardrails || {}, true))
            setUserSizingForm(sizingToForm(userConfig.sizing || {}, true))
            setUserInitialized(true)
        }
    }, [userConfig, userInitialized])

    useEffect(() => {
        if (selectedUserId) {
            setUserInitialized(false)
            setUserGuardrailsForm(guardrailsToForm({}, true))
            setUserSizingForm(sizingToForm({}, true))
        }
    }, [selectedUserId])

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
            const sizing = buildSizingPayload(globalSizingForm, false)
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

    const handleSaveUser = async () => {
        if (!selectedUserId) return
        try {
            setSavingUser(true)
            const guardrails = buildGuardrailsPayload(userGuardrailsForm, true)
            const sizing = buildSizingPayload(userSizingForm, true)
            const response = await fetch(`/api/config/user/${selectedUserId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ guardrails, sizing })
            })
            if (!response.ok) {
                throw new Error("Failed to save user overrides")
            }
            if (userConfigKey) {
                await mutate(userConfigKey)
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

    return (
        <div className="relative h-screen w-full bg-black text-white overflow-hidden">
            <Header />
            <div className="h-full overflow-y-auto no-scrollbar">
                <main className="flex gap-6 p-6 pt-24 min-h-full">
                    <Sidebar />
                    <div className="flex-1 flex flex-col gap-6 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <p className="text-sm text-[#6f6f6f]">Configuration</p>
                                <h1 className="text-3xl font-bold text-white">Guardrails & Sizing</h1>
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
                            <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
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

                                <div className="mt-4 grid grid-cols-2 lg:grid-cols-3 gap-4">
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

                            <div className="flex flex-col gap-6">
                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
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
                                </div>

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
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

                                <div className="bg-[#0D0D0D] rounded-2xl border border-[#27272A] p-6">
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
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxWorseningVsTheirFillCents: value
                                                    }))
                                                }
                                                suffix="cents"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Over Mid"
                                                value={userGuardrailsForm.maxOverMidCents}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxOverMidCents: value
                                                    }))
                                                }
                                                suffix="cents"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Spread"
                                                value={userGuardrailsForm.maxSpreadCents}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxSpreadCents: value
                                                    }))
                                                }
                                                suffix="cents"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Depth Multiplier"
                                                value={userGuardrailsForm.minDepthMultiplier}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        minDepthMultiplier: value
                                                    }))
                                                }
                                                suffix="x"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="No New Opens Within"
                                                value={userGuardrailsForm.noNewOpensMinutes}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        noNewOpensMinutes: value
                                                    }))
                                                }
                                                suffix="min"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Decision Latency"
                                                value={userGuardrailsForm.decisionLatencyMs}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        decisionLatencyMs: value
                                                    }))
                                                }
                                                suffix="ms"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Jitter Max"
                                                value={userGuardrailsForm.jitterMsMax}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        jitterMsMax: value
                                                    }))
                                                }
                                                suffix="ms"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Total Exposure"
                                                value={userGuardrailsForm.maxTotalExposurePct}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxTotalExposurePct: value
                                                    }))
                                                }
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Exposure per Market"
                                                value={userGuardrailsForm.maxExposurePerMarketPct}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxExposurePerMarketPct: value
                                                    }))
                                                }
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Exposure per User"
                                                value={userGuardrailsForm.maxExposurePerUserPct}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxExposurePerUserPct: value
                                                    }))
                                                }
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Daily Loss Limit"
                                                value={userGuardrailsForm.dailyLossLimitPct}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        dailyLossLimitPct: value
                                                    }))
                                                }
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Weekly Loss Limit"
                                                value={userGuardrailsForm.weeklyLossLimitPct}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        weeklyLossLimitPct: value
                                                    }))
                                                }
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Drawdown Limit"
                                                value={userGuardrailsForm.maxDrawdownLimitPct}
                                                onChange={(value) =>
                                                    setUserGuardrailsForm((prev) => ({
                                                        ...prev,
                                                        maxDrawdownLimitPct: value
                                                    }))
                                                }
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
                                                onChange={(value) =>
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        copyPctNotionalPct: value
                                                    }))
                                                }
                                                suffix="%"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Min Trade Notional"
                                                value={userSizingForm.minTradeNotionalUsd}
                                                onChange={(value) =>
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        minTradeNotionalUsd: value
                                                    }))
                                                }
                                                suffix="USDC"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Trade Notional"
                                                value={userSizingForm.maxTradeNotionalUsd}
                                                onChange={(value) =>
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        maxTradeNotionalUsd: value
                                                    }))
                                                }
                                                suffix="USDC"
                                                placeholder="inherit"
                                            />
                                            <Field
                                                label="Max Trade % of Bankroll"
                                                value={userSizingForm.maxTradeBankrollPct}
                                                onChange={(value) =>
                                                    setUserSizingForm((prev) => ({
                                                        ...prev,
                                                        maxTradeBankrollPct: value
                                                    }))
                                                }
                                                suffix="%"
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
