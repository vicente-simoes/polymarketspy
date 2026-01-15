"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useSWRConfig } from "swr"
import { Plus, Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"

import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog"
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/use-toast"

const formSchema = z.object({
    label: z.string().min(1, "Label is required"),
    profileWallet: z.string().length(42, "Must be a valid Ethereum address").startsWith("0x", "Must start with 0x"),
})

export function AddUserDialog() {
    const [open, setOpen] = useState(false)
    const router = useRouter()
    const { mutate } = useSWRConfig()
    const { toast } = useToast()

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            label: "",
            profileWallet: "",
        },
    })

    async function onSubmit(values: z.infer<typeof formSchema>) {
        try {
            const response = await fetch("/api/users/add", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(values),
            })

            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.error || "Failed to add user")
            }

            toast({
                title: "Success",
                description: "User added successfully",
            })

            setOpen(false)
            form.reset()
            mutate("/api/users") // Refresh the user list
            router.refresh()
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Error",
                description: error instanceof Error ? error.message : "Something went wrong",
            })
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button className="bg-[#86efac] hover:bg-[#4ade80] text-black gap-2">
                    <Plus className="h-4 w-4" />
                    Add User
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[600px] bg-[#0D0D0D] border-[#27272A] text-white">
                <DialogHeader>
                    <DialogTitle>Add Followed User</DialogTitle>
                    <DialogDescription className="text-[#919191]">
                        Enter the details of the user you want to copy trade.
                    </DialogDescription>
                </DialogHeader>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="label"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Label</FormLabel>
                                    <FormControl>
                                        <Input placeholder="e.g. Whale 1" {...field} className="bg-[#1A1A1A] border-[#27272A] text-white placeholder:text-[#525252]" />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="profileWallet"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Wallet Address</FormLabel>
                                    <FormControl>
                                        <Input placeholder="0x..." {...field} className="bg-[#1A1A1A] border-[#27272A] text-white placeholder:text-[#525252] font-mono" />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <DialogFooter>
                            <Button type="submit" disabled={form.formState.isSubmitting} className="bg-[#86efac] hover:bg-[#4ade80] text-black">
                                {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Add User
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    )
}
