// Complexity 22: the maximum is 22.
export function classify(value: number) {
  if (value === 0) return '0'
  if (value === 1) return '1'
  if (value === 2) return '2'
  if (value === 3) return '3'
  if (value === 4) return '4'
  if (value === 5) return '5'
  if (value === 6) return '6'
  if (value === 7) return '7'
  if (value === 8) return '8'
  if (value === 9) return '9'
  if (value === 10) return '10'
  if (value === 11) return '11'
  if (value === 12) return '12'
  if (value === 13) return '13'
  if (value === 14) return '14'
  if (value === 15) return '15'
  if (value === 16) return '16'
  if (value === 17) return '17'
  if (value === 18) return '18'
  if (value === 19) return '19'
  if (value === 20) return '20'
  return 'many'
}

// Under the modified variant the whole switch counts once, so ten cases stay
// far below the maximum.
export function choose(value: number) {
  switch (value) {
    case 0:
      return 'zero'
    case 1:
      return 'one'
    case 2:
      return 'two'
    case 3:
      return 'three'
    case 4:
      return 'four'
    case 5:
      return 'five'
    case 6:
      return 'six'
    case 7:
      return 'seven'
    case 8:
      return 'eight'
    case 9:
      return 'nine'
    default:
      return 'many'
  }
}
