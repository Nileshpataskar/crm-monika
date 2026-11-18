import { Component, ElementRef, afterRenderEffect, inject, input, viewChild } from '@angular/core';
import { BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, Tooltip } from 'chart.js';
import { Theme } from '../core/theme';
import { formatInr } from './inr.pipe';

// Register only the Chart.js pieces we use, which keeps the bundle small.
Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

export interface BarSeries {
  label: string;
  data: number[];
  /** A colour token from styles.css, e.g. 'series-1' */
  color: string;
}

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();

/**
 * Bar chart following our chart rules: bars at most 24px thick with rounded ends, a 2px white gap
 * between stacked segments, hairline grid, a legend only when there are 2+ series, and a hover
 * tooltip with rupee amounts.
 */
@Component({
  selector: 'app-bar-chart',
  template: `<div class="relative" [style.height.px]="height()"><canvas #canvas [attr.aria-label]="ariaLabel()" role="img"></canvas></div>`,
})
export class BarChart {
  readonly labels = input.required<string[]>();
  readonly series = input.required<BarSeries[]>();
  readonly horizontal = input(false);
  readonly stacked = input(false);
  readonly money = input(true);
  readonly height = input(260);
  readonly ariaLabel = input('');

  private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private theme = inject(Theme);

  constructor() {
    // Runs after Angular has drawn the <canvas>, and again whenever an input changes.
    afterRenderEffect((onCleanup) => {
      this.theme.effective(); // read it, so switching light/dark redraws the chart in the new colours
      const chart = this.build();
      onCleanup(() => chart.destroy());
    });
  }

  private build(): Chart {
    const horizontal = this.horizontal();
    const stacked = this.stacked();
    const series = this.series();
    const fmt = (v: number) => (this.money() ? formatInr(v, 'compact') : v.toLocaleString('en-IN'));
    const ink3 = token('ink-3');
    const surface = token('surface');

    return new Chart(this.canvas().nativeElement, {
      type: 'bar',
      data: {
        labels: this.labels(),
        datasets: series.map((s, i) => {
          const isOuter = !stacked || i === series.length - 1;
          return {
            label: s.label,
            data: s.data,
            backgroundColor: token(s.color),
            hoverBackgroundColor: token(s.color),
            maxBarThickness: 24,
            borderRadius: isOuter ? 4 : 0,
            borderSkipped: 'start' as const, // square at the baseline, rounded at the value end
            // The 2px "gap" between stacked segments is the surface colour, not a visible border.
            borderColor: surface,
            borderWidth: stacked && !isOuter ? (horizontal ? { right: 2 } : { top: 2 }) : 0,
          };
        }),
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false }, // hovering anywhere on the row shows the tooltip
        layout: { padding: { top: 4, right: 8 } },
        scales: {
          [horizontal ? 'x' : 'y']: {
            stacked,
            beginAtZero: true,
            border: { display: false },
            grid: { color: token('line'), lineWidth: 1 },
            ticks: { color: ink3, font: { size: 12 }, maxTicksLimit: 6, callback: (v) => fmt(Number(v)) },
          },
          [horizontal ? 'y' : 'x']: {
            stacked,
            border: { color: token('line-strong') },
            grid: { display: false },
            ticks: { color: token('ink-2'), font: { size: 12 } },
          },
        },
        plugins: {
          legend: {
            display: series.length > 1,
            position: 'top',
            align: 'start',
            labels: {
              color: token('ink-2'),
              usePointStyle: true,
              pointStyle: 'rectRounded',
              boxWidth: 10,
              boxHeight: 10,
              padding: 16,
              font: { size: 12 },
            },
          },
          tooltip: {
            backgroundColor: token('tooltip'),
            titleColor: token('tooltip-ink'),
            bodyColor: token('tooltip-ink'),
            padding: 10,
            cornerRadius: 6,
            boxPadding: 4,
            usePointStyle: true,
            callbacks: {
              label: (ctx) => {
                const v = Number(ctx.raw);
                return ` ${ctx.dataset.label}: ${this.money() ? formatInr(v) : v.toLocaleString('en-IN')}`;
              },
            },
          },
        },
      },
    });
  }
}
