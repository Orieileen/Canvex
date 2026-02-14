"use client"

import { BadgeCheck, ArrowRight } from "lucide-react"
import NumberFlow from "@number-flow/react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export interface PricingTier {
  name: string
  price: Record<string, number | string>
  description: string
  features: string[]
  cta: string
  highlighted?: boolean
  popular?: boolean
}

interface PricingCardProps {
  tier: PricingTier
  paymentFrequency: string
}


// PayPal付款按钮组件 - Pro层级
const PayPalButtonPro = ({ isHighlighted, cta = "Get Started" }: { isHighlighted?: boolean; cta?: string }) => (
  <form 
    action="https://www.paypal.com/ncp/payment/QKGUN54F2S8Y2" 
    method="post" 
    target="_blank" 
    className="w-full"
  >
    <button
      type="submit"
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 w-full h-9 px-4 py-2",
        isHighlighted 
          ? "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80"
          : "bg-primary text-primary-foreground shadow hover:bg-primary/90"
      )}
    >
      {cta}
      <ArrowRight className="ml-2 h-4 w-4" />
    </button>
  </form>
)

// PayPal付款按钮组件 - Plus层级
const PayPalButtonPlus = ({ isHighlighted, cta = "Get Started" }: { isHighlighted?: boolean; cta?: string }) => (
  <form 
    action="https://www.paypal.com/ncp/payment/E3G2JKPVVXYTW" 
    method="post" 
    target="_blank" 
    className="w-full"
  >
    <button
      type="submit"
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 w-full h-9 px-4 py-2",
        isHighlighted 
          ? "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80"
          : "bg-primary text-primary-foreground shadow hover:bg-primary/90"
      )}
    >
      {cta}
      <ArrowRight className="ml-2 h-4 w-4" />
    </button>
  </form>
)

export function PricingCard({ tier, paymentFrequency }: PricingCardProps) {
  const price = tier.price[paymentFrequency]
  const isHighlighted = tier.highlighted
  const isPopular = tier.popular
  const isPlusTier = tier.name.toLowerCase() === 'plus'
  const isProTier = tier.name.toLowerCase() === 'pro'
  
  // 判断是否为付费层级（有具体数字价格且大于0）
  const isPaidTier = typeof price === 'number' && price > 0

  return (
    <Card
      className={cn(
        "relative flex flex-col gap-8 overflow-hidden p-6",
        isHighlighted
          ? "bg-foreground text-background"
          : "bg-background text-foreground",
        isPopular && "ring-2 ring-primary"
      )}
    >
      {isHighlighted && <HighlightedBackground />}
      {isPopular && <PopularBackground />}

      <h2 className="flex items-center gap-3 text-xl font-medium capitalize">
        {tier.name}
        {isPopular && (
          <Badge variant="secondary" className="mt-1 ml-30 z-10">
            Popular
          </Badge>
        )}
      </h2>

      <div className="relative h-12">
        {typeof price === "number" ? (
          <>
            <NumberFlow
              format={{
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              }}
              value={price}
              className="text-4xl font-medium"
            />
            <p className="-mt-2 text-xs text-muted-foreground">
              Per month/user
            </p>
          </>
        ) : (
          <h1 className="text-4xl font-medium">{price}</h1>
        )}
      </div>

      <div className="flex-1 space-y-2">
        <h3 className="text-sm font-medium">{tier.description}</h3>
        <ul className="space-y-2">
          {tier.features.map((feature, index) => (
            <li
              key={index}
              className={cn(
                "flex items-center gap-2 text-sm font-medium",
                isHighlighted ? "text-background" : "text-muted-foreground"
              )}
            >
              <BadgeCheck className="max-h-4 max-w-4" />
              {feature}
            </li>
          ))}
        </ul>
      </div>

      {isPaidTier ? (
        // 付费层级显示PayPal付款按钮
        isPlusTier ? (
          <PayPalButtonPlus isHighlighted={isHighlighted} cta={tier.cta} />
        ) : isProTier ? (
          <PayPalButtonPro isHighlighted={isHighlighted} cta={tier.cta} />
        ) : (
          // 其他付费层级的fallback（如果有的话）
          <Button
            variant={isHighlighted ? "secondary" : "default"}
            className="w-full"
          >
            {tier.cta}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )
      ) : (
        // 免费层级和Business层级显示普通按钮
        <Button
          variant={isHighlighted ? "secondary" : "default"}
          className="w-full"
        >
          {tier.cta}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      )}
    </Card>
  )
}

const HighlightedBackground = () => (
  <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:45px_45px] [mask-image:radial-gradient(ellipse_80%_50%_at_50%_0%,#000_70%,transparent_110%)]" style={{ pointerEvents: 'none' }} />
)

const PopularBackground = () => (
  <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.1),rgba(255,255,255,0))]" style={{ pointerEvents: 'none' }} />
)
