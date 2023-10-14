package main

import "sync"

type Task func()

type GoroutinePool struct {
	taskChan chan Task
	wg       sync.WaitGroup
}

func NewGoroutinePool(maxGoroutines int) *GoroutinePool {
	pool := &GoroutinePool{
		taskChan: make(chan Task),
	}

	pool.wg.Add(maxGoroutines)
	for i := 0; i < maxGoroutines; i++ {
		go func() {
			for task := range pool.taskChan {
				task()
			}
			pool.wg.Done()
		}()
	}

	return pool
}

func (pool *GoroutinePool) Execute(task Task) {
	pool.taskChan <- task
}

func (pool *GoroutinePool) Close() {
	close(pool.taskChan)
	pool.wg.Wait()
}
