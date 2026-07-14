/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Arm a gate: the five gates the demo relaxes. Each knob mutates the engine config in place, so the
 * next submit above sees it and declines with the reason code the knob arms.
 */

import { Form } from 'react-router';

import { BackField, StatusPill } from '~/ui';
import type { SimSettings } from '~/views';

// One gate knob: a labelled number posting to the sim endpoint, with the reason code it arms.
function KnobForm({
  back,
  op,
  field,
  label,
  value,
  arms,
  busy,
}: {
  back: string;
  op: string;
  field: string;
  label: string;
  value: number;
  arms: string;
  busy: boolean;
}) {
  return (
    <div className="gate-knob">
      <Form method="post" action="/actions/simulate">
        <BackField to={back} />
        <input type="hidden" name="op" value={op} />
        <div className="field">
          <label htmlFor={`knob-${op}`}>{label}</label>
          <div className="row">
            <input
              id={`knob-${op}`}
              name={field}
              type="number"
              min={0}
              defaultValue={value}
            />
            <button type="submit" disabled={busy}>
              Set
            </button>
          </div>
        </div>
      </Form>
      <div className="sb-note">
        Arms <code className="reason-code">{arms}</code>.
      </div>
    </div>
  );
}

export function GateArming({
  settings,
  back,
  busy,
}: {
  settings: SimSettings;
  back: string;
  busy: boolean;
}) {
  return (
    <div className="card card-flush">
      <div className="card-head">
        <h3>Arm a gate</h3>
        <p className="card-sub">
          The demo relaxes these five gates so everyday flow goes through. Arm
          one, then submit above to watch it decline. Each mutates the engine
          config in place, so the next submit sees it.
        </p>
      </div>
      <div className="gate-grid">
        <KnobForm
          back={back}
          op="setMaturity"
          field="days"
          label="Maturity hold (days)"
          value={settings.maturityHorizonDays}
          arms="FUNDS_IMMATURE"
          busy={busy}
        />
        <KnobForm
          back={back}
          op="setVelocity"
          field="credits"
          label="Velocity limit (credits / window)"
          value={settings.velocityLimitCredits}
          arms="RISK_DENIED"
          busy={busy}
        />
        <KnobForm
          back={back}
          op="setPayoutMin"
          field="credits"
          label="Minimum cash-out (credits)"
          value={settings.payoutMinimumCredits}
          arms="BELOW_MINIMUM"
          busy={busy}
        />
        <KnobForm
          back={back}
          op="setPayoutInterval"
          field="days"
          label="Cash-out interval (days)"
          value={settings.payoutIntervalDays}
          arms="PAYOUT_TOO_SOON"
          busy={busy}
        />
        <div className="gate-knob">
          <div className="sb-title">Maintenance window</div>
          <Form method="post" action="/actions/simulate" className="row">
            <BackField to={back} />
            <input
              type="hidden"
              name="op"
              value={
                settings.maintenancePaused ? 'maintenanceOff' : 'maintenanceOn'
              }
            />
            <StatusPill tone={settings.maintenancePaused ? 'red' : 'green'} dot>
              {settings.maintenancePaused ? 'paused' : 'open'}
            </StatusPill>
            <button type="submit" disabled={busy}>
              {settings.maintenancePaused ? 'Reopen economy' : 'Open window'}
            </button>
          </Form>
          <div className="sb-note">
            Arms <code className="reason-code">ECONOMY_PAUSED</code> for
            everyday user writes; Platform and operator writes still go through.
            Advance a day to clear it.
          </div>
        </div>
      </div>
    </div>
  );
}
