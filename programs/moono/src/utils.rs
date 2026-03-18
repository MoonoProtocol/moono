use crate::state::PAGE_SIZE_U32;

pub fn tick_to_page_index(tick: u32) -> (u32, usize) {
    let page = tick / PAGE_SIZE_U32;
    let index = (tick % PAGE_SIZE_U32) as usize;
    (page, index)
}

pub fn set_bit(bitmap: &mut u64, index: usize) {
    *bitmap |= 1u64 << index;
}

pub fn clear_bit(bitmap: &mut u64, index: usize) {
    *bitmap &= !(1u64 << index);
}

pub fn is_bit_set(bitmap: u64, index: usize) -> bool {
    (bitmap & (1u64 << index)) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tick_mapping() {
        let (page, index) = tick_to_page_index(33);
        assert_eq!(page, 1);
        assert_eq!(index, 1);
    }

    #[test]
    fn test_bitmap() {
        let mut bitmap = 0u64;

        set_bit(&mut bitmap, 5);
        assert!(is_bit_set(bitmap, 5));

        clear_bit(&mut bitmap, 5);
        assert!(!is_bit_set(bitmap, 5));
    }
}
