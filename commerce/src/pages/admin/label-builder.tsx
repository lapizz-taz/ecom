import { PageHeader } from '@/components/common/page-header'
import { LabelBuilder } from '@/features/settings/label-builder'

export default function LabelBuilderPage() {
  return (
    <div className="space-y-3">
      <PageHeader title="Label & invoice builder" description="Design the sticker on every parcel and the invoice inside it. Every print uses the saved design." />
      <LabelBuilder />
    </div>
  )
}
