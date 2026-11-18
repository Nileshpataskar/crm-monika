import { Component, ElementRef, afterRenderEffect, inject, input, viewChild } from '@angular/core';
import { ArcElement, Chart, DoughnutController, Tooltip } from 'chart.js';
import { Theme } from '../core/theme';
import { formatInr } from './inr.pipe';

Chart.register(DoughnutController, ArcElement, Tooltip);

export interface DonutSlice {
  label: string;
  value: number;
  /** A colour token from styles.css, e.g. 'series-1' */
  color: string;
}

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();

/** Ring chart for a whole split into a few parts. The big number in the middle is plain HTML on top. */
@Component({
  selector: 'app-donut-chart',
  template: `
    <div class="relative mx-auto" [style.width.px]="size()" [style.height.px]="size()">
      <canvas #canvas role="img" [attr.aria-label]="ariaLabel()"></canvas>
      <div class="absolute inset-0 grid place-content-center text-center pointer-events-none">
        <div class="text-xs text-ink-3">{{ centerLabel() }}</div>
        <div class="text-xl font-semibold tabular-nums">{{ centerValue() }}</div>
      </div>
    </div>
  `,
})
export class DonutChart {
  readonly slices = input.required<DonutSlice[]>();
  readonly centerLabel = input('');
  readonly centerValue = input('');
  readonly size = input(200);
  readonly ariaLabel = input('');

  private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private theme = inject(Theme);

  constructor() {
    afterRenderEffect((onCleanup) => {
      this.theme.effective(); // read it, so switching light/dark redraws the chart in the new colours
      const slices = this.slices();
      const chart = new Chart(this.canvas().nativeElement, {
        type: 'doughnut',
        data: {
          labels: slices.map((s) => s.label),
          datasets: [
            {
              data: slices.map((s) => s.value),
              backgroundColor: slices.map((s) => token(s.color)),
              hoverBackgroundColor: slices.map((s) => token(s.color)),
              borderColor: token('surface'), // 2px surface-coloured gap between slices
              borderWidth: 2,
              borderRadius: 4,
            },
          ],
        },
        options: {
          cutout: '74%',
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 400 },
          plugins: {
            legend: { display: false }, // the legend is drawn in HTML next to the chart
            tooltip: {
              backgroundColor: token('tooltip'),
              titleColor: token('tooltip-ink'),
              bodyColor: token('tooltip-ink'),
              padding: 10,
              cornerRadius: 6,
              callbacks: { label: (ctx) => ` ${ctx.label}: ${formatInr(Number(ctx.raw))}` },
            },
          },
        },
      });
      onCleanup(() => chart.destroy());
    });
  }
}
