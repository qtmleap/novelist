// 章の検査の結果の取り直し。
//
// サーバーは本文の完了 (done) を送った後に検査を走らせる (次の章の生成を待たせないため)。検査には数十秒から
// 数分かかることがあるので、done の直後の取り直しでは review はまだ無い。そこで画面側が、限られた回数だけ取り直す。
// 判断 (次に取り直すか) は純粋関数に、時間の管理だけを startReviewPolling に置き、章ページと小説ページで共有する。

export const REVIEW_POLL_INTERVAL_MS = 15_000
// 15 秒おきに 16 回 (約 4 分)。サーバーのモデルの検査は最長 90 秒、やり直しが入ると 180 秒かかり、
// その前に資料の読み込みもある。結果は最後に 1 回だけ保存される (途中経過は無い)。
export const REVIEW_POLL_MAX_ATTEMPTS = 16

// 取り直した章の一覧に、その章の検査の結果が入っているか。
export function chapterHasReview(
  chapters: ReadonlyArray<{ chapter_number: number; review: unknown }>,
  chapterNumber: number
): boolean {
  return chapters.some((c) => c.chapter_number === chapterNumber && c.review !== null)
}

// 次も取り直すか。結果が入ったら止め、回数が尽きても止める。attemptsDone は取り直した回数。
export function shouldPollAgain(hasReview: boolean, attemptsDone: number): boolean {
  return !hasReview && attemptsDone < REVIEW_POLL_MAX_ATTEMPTS
}

type Options = {
  // 取り直して、検査の結果が入っていれば true を返す。通信の失敗 (例外) は「まだ無い」として扱う。
  check: () => Promise<boolean>
  // 呼び出し側が止めずに終わったとき (結果が入った、または回数が尽きた) に呼ぶ。止めたときは呼ばない。
  onSettled?: () => void
  // 試験用。既定は REVIEW_POLL_INTERVAL_MS。
  intervalMs?: number
}

// 取り直しを始める。戻り値は止める関数 (ページを離れるとき、別の生成が始まったときに呼ぶ)。
// setInterval ではなく、取り直しが終わってから次の setTimeout を張るので、遅い通信でも重ならない。
export function startReviewPolling(options: Options): () => void {
  const intervalMs = options.intervalMs === undefined ? REVIEW_POLL_INTERVAL_MS : options.intervalMs
  const state: { cancelled: boolean; timer: ReturnType<typeof setTimeout> | null } = { cancelled: false, timer: null }

  const run = async (attemptsDone: number) => {
    state.timer = null
    const found = await options.check().catch(() => false)
    if (state.cancelled) return
    if (shouldPollAgain(found, attemptsDone + 1)) {
      schedule(attemptsDone + 1)
      return
    }
    options.onSettled?.()
  }
  const schedule = (attemptsDone: number) => {
    state.timer = setTimeout(() => {
      void run(attemptsDone)
    }, intervalMs)
  }

  schedule(0)
  return () => {
    state.cancelled = true
    if (state.timer !== null) clearTimeout(state.timer)
  }
}
