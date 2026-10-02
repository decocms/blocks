/**
 * The current release's home (/): the v7 landing. Same visual language as the next major's
 * (../Hero, ../Sections, ../Stepper, ../ui); spec in the docs design notes: every claim is something
 * the v7 packages do, and the edge cache and Fast Deploy are qualified as TanStack/Workers features.
 */
import { HomeFrame } from '../Frame'
import { V7_COLUMNS } from './columns'
import { V7Hero } from './Hero'
import { CommerceApps, FastDeploy, LookingAhead, MoveToV7, Production, ThreeRoles, V7FinalCta, V7StackStrip } from './Sections'
import { V7Stepper } from './Stepper'

export function V7Home() {
  return (
    <HomeFrame version="v7" columns={V7_COLUMNS}>
      <V7Hero />
      <V7StackStrip />
      <ThreeRoles />
      <Production />
      <CommerceApps />
      <FastDeploy />
      <V7Stepper />
      <MoveToV7 />
      <LookingAhead />
      <V7FinalCta />
    </HomeFrame>
  )
}
