/**
 * 像素图标图集（P10）。
 *
 * 来源：`pixel-cube-v3.html`（用户提供的「像素方块 V3 · 解码贴图」）。
 * 原文件把一张 **192×32 / 8bit RGB / 72 色** 的 PNG 以 base64 内嵌在 `var ATLAS` 里，
 * 6 个 32×32 图标横向拼接（每格自带纯色底，≤12 色），用 `NearestFilter` 直采。
 *
 * **这里只搬原始字节，不做任何解释。** 切格 / 建调色板 / 生成像素数组的活
 * 在 `scripts/build-icons.mjs` 里，产物是 `src/game/icons.ts`——
 * 那样「图集长什么样」与「我们怎么读它」分成两件事，改读法不用重新搬字节。
 *
 * 不要手改这段 base64。要换图集就重新生成这个文件。
 */

/** 图集原始 PNG 的 base64（不含 `data:` 前缀）。 */
export const ICON_ATLAS_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAMAAAAAgCAIAAADL+uDSAAAUy0lEQVR4nL1cC1RTV7regQDhFSiv' +
  'IKDh2ai5IiWARBCxtz5m2stYHau1wKrt6HBt11SrDO210zrT9nbs09VrrdVxpoPW2qJ9UGfdolXR' +
  'hkLlUYhNlWKEKCABghDecCR37fMnO5uT1wHs/VYWKznZ+fM43/n/739sBK1PhIeKBeiXQZfRVB8u' +
  '5r++t59BCAX6C/mvj17xJ0loEEJI39WDEIL7CCH/ADvv299ndP4UAVlT2Pjf/D9/f/+Yv78n//UI' +
  'oX8kb0O/JPye1CDFurtjSxTIPTLSy/dUTQNdRhPhxJRo4RLEJs0YuGOXHNMA4VN//xhCaHyY6e0Y' +
  'QgiFxjizPz7M9AwzHt7mb0qTCezQpgLDfchKU6ce7gjCJDP85FxTkfPtnPi7BVGg+Qt0GU3G6+MI' +
  'obikKVxAApkPuW9qxD8KQkhbb/6lxLEewJv65hGEUE6qh2ye+MznfU4M8iHZ8ocDGq8YS/93ODrE' +
  'urj2Bw3cyc5WomkBmNffZySmFPfJ6VOeuRIlxohLyqZgs99CGmIHIbRxtVDdjFRlqLdjCOiIT3lV' +
  'jXlRzoNohrCYMqWnYA6Fm7+FWyY+WRMq82maNsAOMWU+B8Ae/ugymi4OmMLjfMmRjvaBLD9BqFgg' +
  'jvXgWIsOESamYjI1XpkUJqYHMJIUI6L90N2CIweWuRL/VTcbEZqph1NjI9igqmySi8JIT+FpZPP2' +
  'vfTDQ+9s43nW7yLcMn0mVEPWi1gc68FfDL2pGS/WTaCLN0/sml16tA3fRyhf6rZH6YmNsBwKFQsg' +
  'ihHcuGp9CG6JP5JiRMTInLmC5Q8HlBQb6AWK++Tk9O9+80NyPDtFRtySLT/olbmrs+Pjo7OzlbQf' +
  'AiTGiNXNxsafZ8QeD2/h+DDzY4PPvy0cSowRq5DR6qJY6vCPX1UV9Y6eEuQ8SKIYBzN3P8QIYaSZ' +
  'QPwjV5fR9KZmvL7zDpMbhhBarRtBS4LREvxU/cnOk+0TayPcQsWCUMpgoL+Qpg6ImPdO907pc7+x' +
  'MYQEuBtXTTeuWkOhf4A4KmoWvfh4qYrcP19784KDuFZeXkmvzE6RxcdHw33aoIe3kI1crtnjYdE0' +
  'BFe/bL9eaSV6rDJ47m8iGn8W/9jABIb7gAcShEkcnXKE0N7PPtd8q4P7h97Ztvezzw//9cvBP06i' +
  '2ubte+VLpNvWPAwPbYlonzotFabaEpdfCht8cDdHSBGDUxO2ApnPxfMDxboJYA8H6mHB0xfHUJbn' +
  '2gg3J0bOfjNwXDuwIMhDfo+X5vaoyzeFZcVf92Wl+BI/BLwkUYyceITQ3KzfYU0dKR0IWYqzs4bi' +
  'uVm/O/CXJznyaOmjL+vb8ImJWLO/T1s12FBc8OLhA3/BKso/QEwkEZouuthQ1aof8oz1RgiNXR+G' +
  'h8HNxtAYMYdqTnyP5lsd8Tff1VwhZKJRVVFfVVFPCMQfd9rq+CxzwpIpEEgg8xGkRYczXejiTfq4' +
  'dAVWQrrTg0xuqPBo1yUdszbCoT+rbx4B0rx3aDlC6PvXvnf5vuteCWm8Yly5/RaqGaRjmV2QkDQQ' +
  'snRVbkFT+6AWocGG4vKaxqioWZLQIP8AMUQoYI8kUqpUJjVJE/TdF/RtuoIXD1d/ZQ2FPFkSaknN' +
  'QCYDDOqB65UGz1hvv03wrLhbxYyVGao/0C1/aR4QiKOy7ToeYM/JuPmfMt2/37oHIcRxP3DE93X9' +
  'grTHP9hftDhlnuvP3VLBlD7vHpl87udq+vAxvbumebIa7qpTfRSHDq7AXPnDRVtLzlyFLXvQzFDf' +
  'PAKR66kVfBPLWpZtsnlieMl7p3uda+fztZjcidvP/NdLhclx/uuXhK/KLYhYs/94qeqhJ16BWtFb' +
  'hz4rePGwJFIasWb/H/7nFLxQ8sjfJJFSUk9yhPFhhmYJYrNx2+Pa052t+qGJlcEPbIlPllkZD95I' +
  'e7rT5RcHx0N8z6dMN0JovdSO4wcAqy7duOrSMhpxJh7kMR70DYUmO38hLw8kkPmcOD9w8PVackB4' +
  'tIvJDYUHutODZltHu/hYy0rxLXxW4hYZ2/LzdT7r3SKXT7SdKXxWYniq7XIPvj56+xm7CT+JONpz' +
  'R+oiCpLj/BFCyXH+Te0JdyKl+jbd0S/KCcncFxUplUl12n54SbeuCU0dofbKQr0dQ9crDRMrg0My' +
  'hetw+iauazRnDCMJPm5sLHOOBWmPg9eJkWMptqfhMv2s7+tcwUR8EnZaa1wYZw7mIISUb70vT1uE' +
  '0B1y/Jje3XZxdc2oV6ZoFJ321D9n+tdufO7X7p0agQQyHxXje0nXqx7mlaO9/nggqQnRqG8eucjG' +
  'oClBcY8Xy7O4Ob7a4Dgh0iKzGKIEkC38ui9UVqYjlAQcWr8k/D1dka+26nhpMSzwXZj/VO4SYE9T' +
  '+2C3runO9zg6SCKlpDJpF47KiR5shgXehbAnWSb6qMnM6W4Vr6LDdzVXwIusl4YlPGou4RShBRwO' +
  'cQCUSs9Iki/BTtQZWirwxROZzLIHOWcPDYFinam25E5bnXCklxbUQj7s+e2rN/Olbqq5biRZ09aP' +
  'HfzWwKrpUCu1WQ104vyAXRFt0DKXe8Yvnvx19L2x+KracdSgZRT3eNkGLA5q/3gxOE5Y+Kyk8FlJ' +
  'zq+8V26/lWXvo4L7OfxyXmvrLRyhvt/ztXZp0/15CRFYooHQ0bIrA+LSQ6QJhD3ac0fwRdym25CT' +
  'mbs6m2N2nKos80GrHjMsJNP6EuJ++ODSjauH//plXc6/CxODSHovRDW7EnFC8OqRC7BM/YK1O5H4' +
  'SgnPahCuLrJpV9pr7ztfBkoIhzAW2AmpFF7hP6G2OtShwcVJC4eELiPXJV1vvtQtTSqMi3CD0rOp' +
  'cUgc65E2YCrWjdGxzPwTOBXRHNhlzDRAgld8fLS5NdamQ23F3XHpCCUAhxIifNmHKERqPkIi12BD' +
  'MUnj+/uMTpIvW98zbpE+Vt+zSZwsEz2WIP6oyQjs4el+oDy4XhpG2APZmSk9hdSX10vDdFERcJ9R' +
  '9xB9/Ymu87uaK84U9EgvczDHPTIZBy+WGRsld2jfw3kINEpNMV/hWGyPrBNGzgf1TQKZi2vrYPWo' +
  'elig/rVXqFhANy5CxYIkS7nZlkPOMdF2Bs0MBi3TG2I+JfquHk7S5B8gPvX3F45+UX68VNX+2da+' +
  'hfmI9kPt5jBKItdgm04SKT38ch7pphEC6bt6nLifcQt1IK6BRvZjIxepONPsETXhZY7yrpab+qqK' +
  '+vXSsF15S2n2mAtF7J1HhCH4SliWQL8wRj7rEQ36BHX+46OyCElQ9GwHFYEOXBoVhMvlaYuAK7Sz' +
  'eTXdHDTgqV3N5meJE6quGcVex9IYcd1Mxc2K8wMIoX1Znhz2AMSxHvnDuKKoHsaaGg7uy/LM8hNM' +
  '6q+FT3rV8I0f0DzxyOVWg9aqqDS3R/NXBax/fgM5UrbvxLslBrklwBm0zMjlVlxCvIY1DRZDFkhC' +
  'g2wdBi4op8hALKPuCwjlkac4vgeS+WWK2XQliQ9o9lR/gI1Axk5yrn9q7ESusevDqb+XQuLG6bZO' +
  'AsUe0h8Ff0NAP4yRzzqJ0NqK+ld5BLIPSwY0KV6EGfIY7HKOWXQ5J43/sARzAPzQqGoEIRFHKwmd' +
  'Nyvype5rLZGL7pgCtnijrdTDRG+T8xIiAKiw6WlMBYC6WhToL6Q905y5gvxYceJj1O/LWFli0DKk' +
  'k6rv6rE7wpGdrbyQrYRq4cC5I+j+PJo9lZU4Pe7TViGETv39hamyB3hjUA+A4plYGYwrk+lhGx8S' +
  'guMB9tiNXM77+fbripb4BUkZh0lTgqlDI2DdCfYoLE4/jSsLK/Zxc8NUlmSqvbjir8LUsQ/7BBLI' +
  'fOq/HE70RjvlHra+B0B3TE/smn3vD9zaBjTFOAdvXDVJ45FoQZSMOihlWnVC/LP+x8brl3vGy95h' +
  '2wj3CmTzrL/1yGUXRWHb6h/xTAGs9KERIk0geXtr6y0oMKKpAOqEiHU8IJlNsiFod1y+e01eulHf' +
  'rLkFedk0CRQuFyryTB0a08ltAsU6FJ1BP5ma4kUo5QhegiNM7RGhIg+PiDgn0Ak2eCWFuUN7VZAW' +
  'PXHkJ3oBmdkAZGi7EL9G7LslhrP3eAXH6TkpfVbKcCFFlxtXTcVf9xV/3cdpaFzu6eCEMDj9tm9U' +
  'Xl5Z8OJhyNhp6QPqBzgE8rngxcMbcjJ378SlFwDdx6DLg6CHupqN1R/oPGO9Sa6OKzfsJ9pxynoV' +
  'cdyPW5khShkclzfJ1TmpRJtBxjxmDlEgytgsqDjEksCaxB3Tu9OSyPxpM33QCPegiVVRmD0U+exE' +
  'nKLKsacvjm1J9dqj9HTLm2/LHk6P3Tl6+xm4KRaJnloReLlnPDhOmBQjIvqGRv6qgAVBeGzI9qnd' +
  'BSZ4yYY4P3oSiNNGBZSXV5bXNAJ7aPfT1D5IMylEmuC7MB9Ki+XllS47X+PDTFez0aAe8Iz1Hknw' +
  'IewB0I6HZo+oaQjks91uq12YSv8FN85xRt0zk/iFoVgnzHnNVFtiOmmWSh+WDBzTuxMRDcif5UYE' +
  'EMC9ju1m5LzG0dGuv4/pUotd6tSHCS/pmKQw96QpfoXoEOGS+P6z3wgIhzS3Rw1a5sznfYmpHvko' +
  '4MznfTDsAQs0t0ezUnwRwsxD2knuxxHA90gipZm5BcTl0OVmpdLyqe/PI10w24YraB2ieXEywvoe' +
  'v03iLDZRRwhBqZBIZkcZO62dnYNR95jTeN5o1tziu1QUiP0HlARbKjiBzBE89c/dYTM42/XONK9A' +
  '5mO61EILZ+P1cbhBvadYN7FT7rFHObUp4EB/oWhBFKeEqLk9+m6JQTZPvC4/+Ow3A/SwB9BItCDK' +
  'rjWQL7SCKS+vBPa4LyqiV3brmvq0VXAjlEqI8HVfVAR+qLym8do169XCQW/HkPZ0p2es98LlYVDm' +
  'QZZcnZQKOewRNQ25lRmgD0868LbdNBqf6Fy3yabPHgsEa/cKFXlM6fPwUNM8vqtqgpR8ANU1o2za' +
  'xbKnrU64pdTubDWXQEWVOCrnS91+u8xPkBZND6oS3bNVd2erDgfIfVlTow6NliBriCWuqKTYUFJs' +
  '0NwehWGPaZjd/eaH4H6WKWY/lYvHlIArwJ7BhmK4deuaSDhTKpMgzB0vVT35pyMkkAEpidsA1TyS' +
  '4KONGgHFg1jH47LQHKsMXjpZ+tilUfRsyVcn96RnJCWXnm36eNI4m0v2fMp0r9X+lJ6RtOkxdnSS' +
  'DxTrsKY+uQ1VHKplc3OS2KemeOFknm2deuqfw3FKkYddl73Z6kkE6jKaYLbQiVM5SKV7MDuG7gaA' +
  'LoXHuguP4bYzzR4nM0Mt3ZPOQX+fEWo/EWv2jy95vU7bT9iDC4YNxRtyMjfkZCKE2j/bqj13BGgE' +
  'HIpYs1/CNlydd+Mh4fqnZmTHqU4imbtVDNzolW5l5hwtONGP6KeuZqOHt9CREoqeLYFm1qdM9zS0' +
  'zqbHVvKa5QCIApFi3Z22OlOHhh43g+wdu58akXVgKGOzIzMO9YSpccjU+BPtdUgz9dYGXDmYBgxa' +
  'alxGyxBmAF0IaWhtRBaz1SNuUcARQOJM8j1swTA7Raa4T36+9qa+TefXfaGP1dHQcG1qT9A7mE2i' +
  'z3e3iqH7XHZBV5wf2BLPSeVo2B7ftubhZzIXb3nt4+TSs+sbwooWLsAnKTGIUffEyGeBv4FqEIlc' +
  'a7U4xflgf5FyTtCU91RsKUUdGubdrEuRyYhqkI2qRsyRy0Y1c+DstyCSuT5MiNiYlehtSgpz0bbl' +
  'A5YNdlzX9MIWAVFCqr2PDoQsDYhL79NW+XVfII1SSPhPHXim9gcNjnRtxWoczvbjS+37PVCVdn6m' +
  'RU1D3QjnX44ks8iScIFqpilCJof4VxGBJQmTNbVd0TMF3zPp41JRqasOIcwVTfO4V1StCWrTVN90' +
  'CgTiOp6rY/uyvPhUmZ0D0ig2w/LfXdCPEAmUjuoCeMG3bPvi22vIoLVmlY6wTDH7eJtO36bzDTHP' +
  'dZCn6I1jeDqRDVikHg0uynacg7if4EQ/qDsDh2zfWmShDiA0RuySK44A7YjN2/euhXHEj+2sgQYq' +
  'QujJ536TNmcumjaiM7Afqi2p3PGfyrfeRyhZtbfPve55oSJPaDMKbQvrvjCoHedL3YjQqe/EXgeO' +
  'kA4XfxAHFugvnDNXgOfqWcny3uneN1KCEXbtvLAkHs9d7D4gOG4hEEyTwTwQSJbaHzSwK2P3zsdz' +
  'V2c/9MQrIJZhyLD6q7c5heb4+Gjih6AVjytMOZk7NuNxrP4+I+mQEBIEhvsszYs+8+cr+EHCJAKJ' +
  'mobGrg+TmuDyl7Az4M8eaHXZjkWT4R6gEbTioZ9KY3XqYk4D1ZFBhxAFosj57h14+LD6xDkvwU8M' +
  '7x2J1n1hsA9wj9KzqHIMpDRCgn2uJuTtwm6lcc5cQW+/8I2NIcVf9xXWGAqnXmJdEOSRleIbHYLp' +
  'KJsnJtt6gEOkLY8nOljeAJYpZtttU8BeDnpldooMVl671sIpcLO7AY0/NvjEKoNb9UNjrEAmAOrE' +
  'KnFHjA+CwnxWLR7bf8BIV4ZMnXrOKcdD8mvwiBkZbP1E1/kJMiv39Iykr97eAdLb7rvQBl3vKozO' +
  'EERnXHp7G6hmu+PPNMwGv6G68bjAw/bYd8o9dsrts8FlzkV2uMJWIbK7eQ6rfxNTPdTVU9vByAHZ' +
  'o0jvcJWEBrW23oIbbCc9deAZPtYkoUFkJSEZlJHo4ejejiE1O94QFOaDVoQFW9rvNGKVwXErHA4s' +
  '0/DwFkbM6gaDnJaFeS/pZCxOmffVSTwtiYcu3v6Y3hFmlzrW+nV6CuuK5nO2Ajr5bIJwudCpZEYj' +
  'vW4PRNjZmfpLQ109Dice+hUzMSWbJ268YuS/L5F2P07+uQK9wBaqMryXdNXisWNf4FgGQWp6kN2L' +
  '30LlYIu0rR8ydeqlltTi4POPIvQo+uXgOF13BDOBIH65RJfR5NwJcbYU0pih7yEoKTZwyj/0PnYO' +
  'nPfY7W7+ok3RNSFVGfoxnHGZ54+7kj4/NkDYsvEEvPc1u4A9O3dlTyqGKJBjyvzNbbch//+AyGG7' +
  'uywcjc2TZiowiZ4hpDGN/9RBm/IPEMNEot18ylEx0MPSr3C0DJ6i1Q92OY7/p8JU/18Hdz200H8x' +
  '/B97/Rj/+nfoDQAAAABJRU5ErkJggg==';

/** 图集尺寸（生成脚本据此切格；判据不手抄这两个数）。 */
export const ICON_ATLAS = { width: 192, height: 32, tiles: 6 } as const;
