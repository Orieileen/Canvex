import type React from "react"
import { useNavigate } from "react-router-dom"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"

interface RegisterFormProps {
  className?: string
  onSubmit?: (data: { email: string; password: string; re_password: string }) => Promise<void>
  onResendActivation?: (email: string) => Promise<void>
}

export function RegisterForm({ 
  className,
  onSubmit,
  onResendActivation
}: RegisterFormProps) {
  const navigate = useNavigate()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [agreeToTerms, setAgreeToTerms] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    re_password: "",
  })
  const [resendStatus, setResendStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [resendMessage, setResendMessage] = useState<string>("")
  const [showResend, setShowResend] = useState<boolean>(false) // 是否展示“重发激活”入口（简单策略：通过表单验证并点击提交后即显示）
  const [resendCooldown, setResendCooldown] = useState<number>(0) // 重发冷却倒计时（秒），0 表示可重发
  const [submitStatus, setSubmitStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [submitMessage, setSubmitMessage] = useState<string>("")

  const { t } = useTranslation(['auth'])
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Validate password match
    if (formData.password !== formData.re_password) {
      toast.error(t('auth:passwordMismatch'))
      return
    }

    // 需求：只要通过表单验证并点击 Create Account，就显示“重发激活”选项（不依赖后端是否成功）
    setShowResend(true)
    setIsLoading(true)
    setSubmitStatus("loading")
    setSubmitMessage("")

    try {
      if (onSubmit) {
        await onSubmit({
          email: formData.email,
          password: formData.password,
          re_password: formData.re_password,
        })
        setSubmitStatus("success")
        setSubmitMessage("Registration successful. Please check your email to activate your account.")
      }
    } catch (error) {
      console.error("Registration failed:", error)
      setSubmitStatus("error")
      const maybeAxios = error as { response?: { data?: unknown } }
      const serverMsg = maybeAxios?.response?.data as unknown
      const msg = typeof serverMsg === "string"
        ? serverMsg
        : (serverMsg && typeof serverMsg === "object"
            ? Object.values(serverMsg as Record<string, unknown>)
                .flat()
                .map((v) => String(v))
                .join(" ")
            : "Registration failed. Please try again.")
      setSubmitMessage(msg)
    } finally {
      setIsLoading(false)
      if (submitStatus === "loading") setSubmitStatus("idle")
    }
  }

  const handleInputChange = (field: string, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const handleResendActivation = async () => {
    if (!formData.email) {
      setResendStatus("error")
      setResendMessage("Please enter your email first.")
      return
    }
    try {
      setResendStatus("loading")
      setResendMessage("")
      if (!onResendActivation) throw new Error("No handler provided")
      await onResendActivation(formData.email)
      setResendStatus("success")
      // 说明：部分提供商可能有延迟/拦截，请提醒查看垃圾箱与“促销/通知”标签
      setResendMessage("Activation email sent. Please check your inbox or spam folder.")
      // 启动 60s 冷却，防止频繁点击导致后端限流/退信
      setResendCooldown(60)
      const timer = setInterval(() => {
        setResendCooldown((s) => {
          if (s <= 1) { clearInterval(timer); return 0 }
          return s - 1
        })
      }, 1000)
    } catch {
      setResendStatus("error")
      setResendMessage("Failed to resend. Please try again later.")
    }
  }
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <Card>
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            Enter your information below
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
              <div className="grid gap-3">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="m@example.com"
                  value={formData.email}
                  onChange={(e) => handleInputChange("email", e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-3">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    // placeholder="Enter your password"
                    value={formData.password}
                    onChange={(e) => handleInputChange("password", e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div className="grid gap-3">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    type={showConfirmPassword ? "text" : "password"}
                    // placeholder="Confirm your password"
                    value={formData.re_password}
                    onChange={(e) => handleInputChange("re_password", e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground hover:text-foreground"
                  >
                    {showConfirmPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="terms"
                  checked={agreeToTerms}
                  onCheckedChange={(checked) => setAgreeToTerms(checked as boolean)}
                />
                <Label htmlFor="terms" className="text-[12px]">
                  I agree to the{" "}
                  <a
                    href="/terms"
                    className="underline underline-offset-4 hover:text-primary"
                  >
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a
                    href="/privacy"
                    className="underline underline-offset-4 hover:text-primary"
                  >
                    Privacy Policy
                  </a>
                </Label>
              </div>
              <div className="flex flex-col gap-3">
                <Button 
                  type="submit" 
                  className="w-full"
                  disabled={isLoading || !agreeToTerms}
                >
                  {isLoading ? "Creating..." : "Create Account"}
                </Button>
                {submitStatus !== "idle" && submitMessage && (
                  <div
                    className={cn(
                      "text-xs text-center",
                      submitStatus === "success" ? "text-green-600" : "text-red-600"
                    )}
                  >
                    {submitMessage}
                  </div>
                )}
                {/* 简化逻辑：只要通过表单验证并点击了 Create Account，就展示“未收到邮件？重发激活” */}
                {showResend && (
                  <div className="text-center text-sm">
                    <span className="text-muted-foreground">
                      {/* 增强提示语：补充“邮箱已注册但未激活”的场景，引导用户直接重发 */}
                      Didn't receive the email? Or is the email address already registered but not activated?
                    </span>
                    <button
                      type="button"
                      onClick={handleResendActivation}
                      // 冷却中或未填写邮箱/加载中时禁用
                      disabled={!formData.email || resendStatus === "loading" || resendCooldown > 0}
                      className="underline underline-offset-4 disabled:opacity-60"
                    >
                      {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend activation"}
                    </button>
                  </div>
                )}
                {resendStatus !== "idle" && resendMessage && (
                  <div
                    className={cn(
                      "text-xs text-center",
                      resendStatus === "success" ? "text-green-600" : "text-red-600"
                    )}
                  >
                    {resendMessage}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 text-center text-sm">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => navigate("/login")}
                className="underline underline-offset-4"
              >
                Sign in
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
