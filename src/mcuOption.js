/**
 * mcuOption.js
 * MicroPython and CircuitPython supported microcontrollers
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const languageOption = ['Micropython', 'CircuitPython'];

// --- MicroPython ---
const mcuOptions_MP = ['RP2', 'ESP', 'STM', 'SAM', 'NRF', 'RA', 'Any'];

const rpBoards_MP = ['rp2040', 'rp2350'];

const espBoards_MP = ['esp32', 'esp32c3', 'esp32c6', 'esp32s2', 'esp32s3', 'esp8266'];

const stmBoards_MP = [
    'stm32f0', 'stm32f4', 'stm32f411', 'stm32f7',
    'stm32g0', 'stm32g4', 'stm32h5', 'stm32h7',
    'stm32l0', 'stm32l1', 'stm32l4', 'stm32wb', 'stm32wl'
];

const samBoards_MP = ['samd21', 'samd51'];

const nrfBoards_MP = ['nrf51', 'nrf52', 'nrf91'];

const raBoards_MP = ['ra4m1', 'ra4w1', 'ra6m1', 'ra6m2', 'ra6m5'];

const mix_MP = ['AE722F80F55D5XX', 'cc3200', 'mimxrt'];

// --- CircuitPython ---
const mcuOptions_CP = ['RP2', 'ESP', 'SAM', 'NRF'];

const rpBoards_CP = ['rp2040', 'rp2350'];

const espBoards_CP = ['esp32-s2', 'esp32-s3'];

const samBoards_CP = ['samd21', 'samd51'];

const nrfBoards_CP = ['nrf52840'];

module.exports = {
    languageOption,
    mcuOptions_MP,
    rpBoards_MP, espBoards_MP, stmBoards_MP,
    samBoards_MP, nrfBoards_MP, raBoards_MP, mix_MP,
    mcuOptions_CP,
    rpBoards_CP, espBoards_CP, samBoards_CP, nrfBoards_CP
};