import { useStore } from '../store'
import { Column } from './Column'

export function Board() {
  const board = useStore((s) => s.board)
  if (!board) return null

  return (
    <div className="board">
      {board.columns.map((col) => (
        <Column key={col.id} column={col} />
      ))}
    </div>
  )
}
